import { setTimeout as delay } from 'node:timers/promises';

import { buildParameterWriteFrame, decodeFirstCbor, type TrumaValue } from './truma-frame.js';
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

export interface WriteParameterRequest {
  targetGroup: number;
  topicName: string;
  parameterName: string;
  value: TrumaValue;
}

const DEFAULT_TIMINGS = {
  subscribeSettleMs: 150,
  responseIdleMs: 700,
  subscribeTimeoutMs: 10000,
  readyTimeoutMs: 1500,
  acceptedTimeoutMs: 1500,
  clientAddressTimeoutMs: 1500,
  writeConfirmationTimeoutMs: 1500,
  pairingSubscribeTimeoutMs: 10000,
  handshakeSettleMs: 120,
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
    this.data.onData((data) => {
      this.handleDataNotification(data).catch((error) => {
        this.log(`Could not process data notification: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    await withTimeout(this.control.subscribe(), this.timings.subscribeTimeoutMs, 'control characteristic subscription');
    this.log('Control characteristic subscribed.');
    await withTimeout(this.data.subscribe(), this.timings.subscribeTimeoutMs, 'data characteristic subscription');
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
    await withTimeout(this.control.subscribe(), this.timings.pairingSubscribeTimeoutMs, 'protected control subscription');
    this.log('Control subscription call completed.');
  }

  async readAll({ sequence = READ_SEQUENCE }: { sequence?: ReadRequest[] } = {}) {
    await this.start();

    try {
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
      return this.getResponseBuffers();
    } finally {
      this.clearIdleTimer();
    }
  }

  async initializeClientAddress() {
    await this.start();

    const request = READ_SEQUENCE[0];
    if (!request.hex && !request.build) throw new Error('Protocol-version request does not define a payload.');
    const payload = request.build ? request.build() : Buffer.from(request.hex || '', 'hex');
    this.log(`Sending ${request.name} (${payload.length} bytes)`);
    await this.sendFrame(payload, request);
    await this.waitForClientAddress(this.timings.clientAddressTimeoutMs);
    await delay(this.timings.handshakeSettleMs);
    await this.drainPendingResponseBeforeNextPayload();
    this.clearCollectedResponses();
  }

  async writeParameter({ targetGroup, topicName, parameterName, value }: WriteParameterRequest) {
    await this.start();

    const responseStartIndex = this.responseBuffers.length;
    const payload = buildParameterWriteFrame(targetGroup, topicName, parameterName, value);
    await this.sendFrame(payload, {
      name: `set-${topicName}-${parameterName}`,
      addressMode: 'source-client'
    });

    await this.waitForParameterResponse(topicName, parameterName, responseStartIndex, this.timings.writeConfirmationTimeoutMs);
    await this.flushCurrentResponse();
    const responses = this.getResponseBuffers().slice(responseStartIndex);
    const matchingResponses = responses.filter((response) => responseMatchesParameter(response, topicName, parameterName));
    return matchingResponses.length ? matchingResponses : responses;
  }

  async sendFrame(payload: Buffer, request: ReadRequest = { name: '<anonymous>' }) {
    const responseCountBeforeWrite = this.responseBuffers.length;
    const pendingCountBeforeWrite = this.pendingResponseCount;
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
    try {
      await accepted;
    } catch (error) {
      await this.drainPendingResponseBeforeNextPayload();
      if (this.hasProgressSince(responseCountBeforeWrite, pendingCountBeforeWrite)) {
        this.log(`Did not receive f001 for ${request.name}, but response traffic progressed; continuing with collected data.`);
        return;
      }
      throw error;
    }
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

  async handleDataNotification(data: Buffer) {
    this.log(`Data notification (${data.length} bytes): ${data.toString('hex')}`);

    if (!startsTrumaFrame(data) && !this.currentChunks.length && this.responseBuffers.length) {
      this.responseBuffers[this.responseBuffers.length - 1] = Buffer.concat([this.responseBuffers[this.responseBuffers.length - 1], Buffer.from(data)]);
      this.log(`Appended trailing data fragment (${data.length} bytes) to previous response.`);
      return;
    }

    if (startsTrumaFrame(data) && this.currentChunks.length) {
      this.log('New response frame started before previous frame was flushed; flushing previous frame first.');
      await this.flushCurrentResponse();
    }

    this.currentChunks.push(Buffer.from(data));
    if (this.currentResponseReachedExpectedLength()) {
      this.log('Response frame reached expected length; flushing immediately.');
      await this.flushCurrentResponse();
      return;
    }

    this.bumpIdle();
  }

  currentResponseReachedExpectedLength() {
    if (!this.currentChunks.length) return false;
    const response = Buffer.concat(this.currentChunks);
    const expectedLength = expectedTrumaFrameLength(response);
    if (expectedLength === null) return false;
    this.log(`Response frame progress: ${response.length}/${expectedLength} byte minimum.`);
    return response.length >= expectedLength;
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
    this.clearIdleTimer();
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

  getResponseBuffers() {
    const responses = this.responseBuffers.slice();
    if (this.currentChunks.length) responses.push(Buffer.concat(this.currentChunks));
    return responses;
  }

  clearCollectedResponses() {
    this.responseBuffers.length = 0;
    this.currentChunks = [];
  }

  close() {
    this.clearIdleTimer();
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  private hasProgressSince(responseCount: number, pendingCount: number) {
    return this.responseBuffers.length > responseCount || this.currentChunks.length > 0 || this.pendingResponseCount > pendingCount;
  }

  private clearIdleTimer() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
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

  async waitForClientAddress(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (this.clientAddress === null) {
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for assigned Truma client address.`);
      await delay(25);
    }
  }

  async waitForParameterResponse(topicName: string, parameterName: string, startIndex: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.getResponseBuffers().slice(startIndex).some((response) => responseMatchesParameter(response, topicName, parameterName))) return;
      await delay(25);
    }
    this.log(`Timed out after ${timeoutMs}ms waiting for confirmation of ${topicName}.${parameterName}; returning collected write responses.`);
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

function startsTrumaFrame(data: Buffer): boolean {
  if (data.length < 18) return false;
  const operation = data.readUInt16LE(6);
  return operation === 1 || operation === 2 || operation === 3;
}

function expectedTrumaFrameLength(data: Buffer): number | null {
  if (data.length < 6) return null;
  const declaredBodyLength = data.readUInt16LE(4);
  if (declaredBodyLength <= 0) return null;

  // The captured iNet X app traffic considers a response frame complete once
  // the declared body length plus the short transport prefix has arrived.
  return declaredBodyLength + 3;
}

function responseMatchesParameter(response: Buffer, topicName: string, parameterName: string): boolean {
  const decoded = decodeFirstCbor(response);
  const candidate = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;

  if (isRecord(candidate) && candidate.tn === topicName && candidate.pn === parameterName) return true;
  if (isRecord(candidate) && Array.isArray(candidate.topics)) {
    return candidate.topics.some((topic) => {
      if (!isRecord(topic) || topic.tn !== topicName || !Array.isArray(topic.parameters)) return false;
      return topic.parameters.some((parameter) => isRecord(parameter) && parameter.pn === parameterName);
    });
  }

  return false;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms during ${label}.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
