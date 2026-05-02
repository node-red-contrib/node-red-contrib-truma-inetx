import { setTimeout as delay } from 'node:timers/promises';

import { decodeFirstCbor } from './truma-frame.js';
import { READ_SEQUENCE } from './constants.js';

export interface TrumaCharacteristic {
  uuid: string;
  properties: string[];
  read(): Promise<Buffer>;
  write(data: Buffer, withoutResponse?: boolean): Promise<void>;
  subscribe(): Promise<void>;
  onData(listener: (data: Buffer) => void): void;
}

export interface TrumaCharacteristics {
  control: TrumaCharacteristic;
  write: TrumaCharacteristic;
  data: TrumaCharacteristic;
  extraNotify: TrumaCharacteristic | null;
  softwareRevision: TrumaCharacteristic | null;
}

export interface TrumaProtocolOptions {
  logger?: (message: string) => void;
  timings?: Partial<typeof DEFAULT_TIMINGS>;
}

export interface ReadRequest {
  name: string;
  hex?: string;
  build?: () => Buffer;
  addressMode?: 'source-client' | 'client-local';
  dynamic?: 'device-groups';
}

const DEFAULT_TIMINGS = {
  subscribeSettleMs: 150,
  responseIdleMs: 700,
  readyTimeoutMs: 1500,
  acceptedTimeoutMs: 1500,
  interleavedResponseSettleMs: 80,
  pipelineSettleMs: 0,
  finalDrainMs: 2500
};

export class TrumaProtocol {
  private readonly control: TrumaCharacteristic;
  private readonly write: TrumaCharacteristic;
  private readonly data: TrumaCharacteristic;
  private readonly logger: (message: string) => void;
  private readonly timings: typeof DEFAULT_TIMINGS;
  private readonly responseBuffers: Buffer[] = [];
  private currentChunks: Buffer[] = [];
  private idleResolvers: Array<() => void> = [];
  private controlWaiters: Array<{ expectedHex: string; resolve: () => void }> = [];
  private pendingResponseCount = 0;
  private clientAddress: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private isStarted = false;

  constructor(characteristics: TrumaCharacteristics, { logger = () => {}, timings = {} }: TrumaProtocolOptions = {}) {
    this.control = characteristics.control;
    this.write = characteristics.write;
    this.data = characteristics.data;
    this.logger = logger;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  async start() {
    if (this.isStarted) return;
    this.log('Subscribing to control and data characteristics.');
    this.control.onData((data) => this.handleControlNotification(data));
    this.data.onData((data) => this.handleDataNotification(data));

    await this.control.subscribe();
    this.log('Control characteristic subscribed.');
    await this.data.subscribe();
    this.log('Data characteristic subscribed.');
    await delay(this.timings.subscribeSettleMs);
    this.log(`Subscription settle complete (${this.timings.subscribeSettleMs}ms).`);
    this.isStarted = true;
  }

  async triggerPairingOnly() {
    this.log('Installing control notification handler.');
    this.control.onData((data) => {
      this.log(`Control notification: ${data.toString('hex')}`);
      this.handleControlNotification(data);
    });
    this.log('Subscribing to protected control characteristic. This should write 01 00 to its CCCD.');
    await this.control.subscribe();
    this.log('Control subscription call completed.');
  }

  async readAll({ sequence = READ_SEQUENCE }: { sequence?: ReadRequest[] } = {}) {
    await this.start();

    for (const request of sequence) {
      if (request.dynamic === 'device-groups') {
        await this.readDetectedDeviceGroups(request.name);
        continue;
      }

      if (!request.hex && !request.build) throw new Error(`Read request ${request.name} does not define a payload.`);
      const payload = request.build ? request.build() : Buffer.from(request.hex || '', 'hex');
      this.log(`Sending ${request.name} (${payload.length} bytes)`);
      await this.sendFrame(payload, request);
      await delay(this.timings.pipelineSettleMs);
    }

    await delay(this.timings.finalDrainMs);
    await this.drainPendingResponseAtEnd();
    await this.flushCurrentResponse();
    return this.responseBuffers;
  }

  async sendFrame(payload: Buffer, request: ReadRequest = { name: '<anonymous>' }) {
    const announce = Buffer.from([0x01, payload.length & 0xff, (payload.length >> 8) & 0xff]);
    this.log(`Writing control announce: ${announce.toString('hex')}`);
    const ready = this.waitForControlNotification('8100', this.timings.readyTimeoutMs);
    await this.control.write(announce, false);
    await ready;
    this.log(`Control ready received for ${request.name}.`);
    await this.drainPendingResponseBeforeNextPayload();
    payload = this.applyClientAddress(payload, request.addressMode);
    this.log(`Writing data frame (${payload.length} bytes): ${payload.toString('hex')}`);
    const accepted = this.waitForControlNotification('f001', this.timings.acceptedTimeoutMs);
    await this.write.write(payload, true);
    await accepted;
    this.log(`Control accepted ${request.name}.`);
  }

  handleControlNotification(data: Buffer) {
    const hex = data.toString('hex');
    this.log(`Control notification: ${hex}`);
    this.resolveControlWaiters(hex);

    if (data.length >= 1 && data[0] === 0x83) {
      // Device has a response ready. The official app sends 03 00 promptly,
      // but it may announce the next frame before this response data arrives.
      this.pendingResponseCount += 1;
      const responseLength = data.length >= 3 ? data.readUInt16LE(1) : null;
      this.log(
        `Device announced response ready${responseLength === null ? '' : ` (${responseLength} byte payload)`}; pending response count is ${this.pendingResponseCount}.`
      );
      this.control.write(Buffer.from([0x03, 0x00]), false).catch((error) => {
        this.log(`Could not request response payload: ${error.message}`);
      });
      return;
    }

    if (hex === 'f001') {
      this.bumpIdle();
    }
  }

  handleDataNotification(data: Buffer) {
    this.log(`Data notification (${data.length} bytes): ${data.toString('hex')}`);
    this.currentChunks.push(Buffer.from(data));
    this.bumpIdle();
  }

  bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.handleIdleTimeout(), this.timings.responseIdleMs);
  }

  waitForIdle(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
      if (!this.idleTimer) {
        this.idleTimer = setTimeout(() => this.handleIdleTimeout(), timeoutMs);
      }
    });
  }

  handleIdleTimeout() {
    this.idleTimer = null;
    const flushed = this.currentChunks.length ? this.flushCurrentResponse() : Promise.resolve();

    flushed.finally(() => {
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    });
  }

  async drainPendingResponseBeforeNextPayload() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await delay(this.timings.interleavedResponseSettleMs);
      if (this.currentChunks.length) {
        this.log('Flushing interleaved response before writing next data frame.');
        await this.flushCurrentResponse();
        continue;
      }
      if (this.pendingResponseCount === 0) break;
    }
  }

  async drainPendingResponseAtEnd() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await delay(this.timings.interleavedResponseSettleMs);
      if (this.currentChunks.length) {
        await this.flushCurrentResponse();
        continue;
      }
      if (this.pendingResponseCount === 0) break;
    }
  }

  async readDetectedDeviceGroups(name: string) {
    await this.drainPendingResponseAtEnd();
    const deviceIds = this.detectDeviceIds();
    if (!deviceIds.length) {
      this.log(`Skipping ${name}: no device list response was decoded.`);
      return;
    }

    this.log(`Reading ${deviceIds.length} detected device group(s): ${deviceIds.map(formatAddress).join(', ')}`);
    for (const deviceId of deviceIds) {
      const payload = this.buildReadGroupFrame(deviceId);
      this.log(`Sending read-group-${formatAddress(deviceId).slice(2)} (${payload.length} bytes)`);
      await this.sendFrame(payload);
      await delay(this.timings.pipelineSettleMs);
    }
  }

  detectDeviceIds() {
    const deviceIds = [];

    for (const response of this.responseBuffers) {
      const decoded = decodeFirstCbor(response);
      const candidate = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;
      if (!isRecord(candidate) || !Array.isArray(candidate.Devices)) continue;

      for (const value of candidate.Devices) {
        if (Number.isInteger(value) && value >= 0 && value <= 0xffff) deviceIds.push(value);
      }
    }

    return [...new Set(deviceIds)];
  }

  buildReadGroupFrame(deviceId: number) {
    const payload = Buffer.from('000000050b00030000000000000000000400', 'hex');
    payload.writeUInt16LE(deviceId, 0);
    if (this.clientAddress !== null) payload.writeUInt16LE(this.clientAddress, 2);
    return payload;
  }

  applyClientAddress(payload: Buffer, mode: ReadRequest['addressMode']) {
    if (!mode || this.clientAddress === null) return payload;

    const rewritten = Buffer.from(payload);
    if (mode === 'source-client' || mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 2);
    if (mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 0);
    this.log(`Applied client address ${formatAddress(this.clientAddress)} using mode ${mode}.`);
    return rewritten;
  }

  async flushCurrentResponse() {
    if (!this.currentChunks.length) return;
    const response = Buffer.concat(this.currentChunks);
    this.currentChunks = [];
    this.responseBuffers.push(response);
    this.learnClientAddress(response);
    this.log(`Flushed response payload (${response.length} bytes): ${response.toString('hex')}`);
    await this.control.write(Buffer.from([0xf0, 0x01]), false).catch((error) => {
      this.log(`Could not acknowledge response payload: ${error.message}`);
    });
    if (this.pendingResponseCount > 0) this.pendingResponseCount -= 1;
    this.log(`Response acknowledged; pending response count is ${this.pendingResponseCount}.`);
  }

  learnClientAddress(response: Buffer) {
    if (this.clientAddress !== null) return;

    const decoded = decodeFirstCbor(response);
    if (!isRecord(decoded) || !Number.isInteger(decoded.addr)) return;

    this.clientAddress = decoded.addr as number;
    this.log(`Using assigned Truma client address ${formatAddress(this.clientAddress)}.`);
  }

  waitForControlNotification(expectedHex: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let waiter: { expectedHex: string; resolve: () => void };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for control notification ${expectedHex}.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.controlWaiters = this.controlWaiters.filter((candidate) => candidate !== waiter);
      };
      waiter = {
        expectedHex,
        resolve: () => {
          cleanup();
          resolve();
        }
      };
      this.controlWaiters.push(waiter);
    });
  }

  resolveControlWaiters(hex: string) {
    const waiters = this.controlWaiters.slice();
    for (const waiter of waiters) {
      if (waiter.expectedHex === hex) waiter.resolve();
    }
  }

  private log(message: string) {
    this.logger(message);
  }
}

function formatAddress(address: number) {
  return `0x${address.toString(16).padStart(4, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
