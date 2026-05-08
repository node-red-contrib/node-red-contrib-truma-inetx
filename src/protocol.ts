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
  topics?: string[];
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
  responseAnnounceWaitMs: 300,
  responseQuietMs: 250,
  responseDrainTimeoutMs: 8000,
  pipelineSettleMs: 0
};

const TOPIC_GROUP_HINTS = new Map<string, number[]>([
  ['AirHeating', [0x0201]],
  ['FreshWater', [0x0405]],
  ['GreyWater', [0x0405]],
  ['RoomClimate', [0x0101]],
  ['Switches', [0x0405]],
  ['WaterHeating', [0x0201]]
]);

export class TrumaProtocol {
  private readonly control: TrumaCharacteristic;
  private readonly write: TrumaCharacteristic;
  private readonly data: TrumaCharacteristic;
  private readonly logger: (message: string) => void;
  private readonly timings: typeof DEFAULT_TIMINGS;
  private readonly responseBuffers: Buffer[] = [];
  private currentChunks: Buffer[] = [];
  private currentExpectedLength: number | null = null;
  private announcedResponseLengths: number[] = [];
  private idleResolvers: Array<() => void> = [];
  private drainResolvers: Array<() => void> = [];
  private controlWaiters: Array<{ expectedHex: string; resolve: () => void }> = [];
  private pendingResponseCount = 0;
  private drainActivityCounter = 0;
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
          await this.readDetectedDeviceGroups(request);
          continue;
        }

        if (!request.hex && !request.build) throw new Error(`Read request ${request.name} does not define a payload.`);
        const payload = request.build ? request.build() : Buffer.from(request.hex || '', 'hex');
        this.log(`Sending ${request.name} (${payload.length} bytes)`);
        await this.sendFrame(payload, request);
        await delay(this.timings.pipelineSettleMs);
      }

      await this.drainPendingResponseAtEnd();
      if (this.currentChunks.length && this.currentResponseReachedExpectedLength()) await this.flushCurrentResponse();
      else if (this.currentChunks.length) this.log('Leaving incomplete announced response out of parsed results.');
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
    await this.drainResponseAfterAcceptedFrame(request.name);
  }

  handleControlNotification(data: Buffer) {
    const hex = data.toString('hex');
    this.log(`Control notification: ${hex}`);
    this.resolveControlWaiters(hex);

    if (data.length >= 1 && data[0] === 0x83) {
      // Device has a response ready. The official app sends 03 00 promptly,
      // but it may announce the next frame before this response data arrives.
      const responseLength = data.length >= 3 ? data.readUInt16LE(1) : null;
      if (responseLength !== null) this.announcedResponseLengths.push(responseLength);
      this.pendingResponseCount += 1;
      this.log(
        `Device announced response ready${responseLength === null ? '' : ` (${responseLength} byte payload)`}; pending response count is ${this.pendingResponseCount}.`
      );
      this.markDrainActivity();
      this.resolveDrainWaiters();
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

    if (!startsTrumaFrame(data) && !this.currentChunks.length && this.responseBuffers.length && this.currentExpectedLength === null) {
      this.responseBuffers[this.responseBuffers.length - 1] = Buffer.concat([this.responseBuffers[this.responseBuffers.length - 1], Buffer.from(data)]);
      this.log(`Appended trailing data fragment (${data.length} bytes) to previous response.`);
      this.markDrainActivity();
      this.resolveDrainWaiters();
      return;
    }

    if (startsTrumaFrame(data) && this.currentChunks.length) {
      if (this.currentResponseReachedExpectedLength()) {
        this.log('New response frame started after previous frame reached expected length; flushing previous frame first.');
        await this.flushCurrentResponse();
      } else {
        this.log('New response frame started before previous announced frame was complete; flushing incomplete frame before resynchronizing.');
        await this.flushCurrentResponse({ incomplete: true });
      }
    }

    if (!this.currentChunks.length) this.currentExpectedLength = this.announcedResponseLengths.shift() ?? expectedTrumaFrameLength(data);
    this.currentChunks.push(Buffer.from(data));
    this.markDrainActivity();
    this.resolveDrainWaiters();
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
    const expectedLength = this.currentExpectedLength ?? expectedTrumaFrameLength(response);
    if (expectedLength === null) return false;
    this.log(`Response frame progress: ${response.length}/${expectedLength} byte(s).`);
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
    const shouldFlush = this.currentChunks.length && (this.currentExpectedLength === null || this.currentResponseReachedExpectedLength());
    if (this.currentChunks.length && !shouldFlush) {
      this.log('Idle timeout reached while announced response is incomplete; waiting for remaining data.');
    }
    const flushed = shouldFlush ? this.flushCurrentResponse() : Promise.resolve();

    flushed.finally(() => {
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    });
  }

  async drainPendingResponseBeforeNextPayload() {
    await this.drainResponseBurst('before next payload', { requireFirstResponse: false });
  }

  async drainResponseAfterAcceptedFrame(name: string) {
    await this.drainResponseBurst(name, { requireFirstResponse: true });
  }

  async drainPendingResponseAtEnd() {
    await this.drainResponseBurst('final drain', { requireFirstResponse: false });
  }

  async drainResponseBurst(name: string, { requireFirstResponse }: { requireFirstResponse: boolean }) {
    const deadline = Date.now() + this.timings.responseDrainTimeoutMs;
    let sawResponse = this.currentChunks.length > 0 || this.pendingResponseCount > 0;
    let quietStartedAt = sawResponse && this.currentChunks.length === 0 && this.pendingResponseCount === 0 ? Date.now() : null;
    let lastActivityCounter = this.drainActivityCounter;

    while (Date.now() < deadline) {
      if (this.currentChunks.length) {
        sawResponse = true;
        quietStartedAt = null;
        if (this.currentResponseReachedExpectedLength()) {
          const response = await this.flushCurrentResponse();
          if (response && responseHasLastMessage(response) && this.pendingResponseCount === 0) return;
          continue;
        }
        await this.waitForDrainProgress(deadline - Date.now());
        continue;
      }

      if (this.pendingResponseCount > 0) {
        sawResponse = true;
        quietStartedAt = null;
        lastActivityCounter = this.drainActivityCounter;
        await this.waitForDrainProgress(deadline - Date.now());
        continue;
      }

      if (!sawResponse) {
        const waitMs = Math.min(this.timings.responseAnnounceWaitMs, deadline - Date.now());
        await this.waitForDrainProgress(waitMs);
        if (this.currentChunks.length || this.pendingResponseCount > 0 || this.drainActivityCounter !== lastActivityCounter) {
          sawResponse = true;
          quietStartedAt = null;
          lastActivityCounter = this.drainActivityCounter;
          continue;
        }
        if (requireFirstResponse) this.log(`No response announcement arrived for ${name} within ${this.timings.responseAnnounceWaitMs}ms; continuing.`);
        return;
      }

      if (quietStartedAt === null) {
        quietStartedAt = Date.now();
        lastActivityCounter = this.drainActivityCounter;
      }

      const quietRemainingMs = this.timings.responseQuietMs - (Date.now() - quietStartedAt);
      if (quietRemainingMs <= 0) return;

      await this.waitForDrainProgress(Math.min(quietRemainingMs, deadline - Date.now()));
      if (this.currentChunks.length || this.pendingResponseCount > 0 || this.drainActivityCounter !== lastActivityCounter) {
        quietStartedAt = null;
        lastActivityCounter = this.drainActivityCounter;
      }
    }

    this.log(`Timed out after ${this.timings.responseDrainTimeoutMs}ms draining response burst for ${name}; continuing with collected data.`);
  }

  async readDetectedDeviceGroups(request: ReadRequest) {
    await this.drainPendingResponseAtEnd();
    const requestedTopics = request.topics?.map((topic) => topic.trim()).filter(Boolean) ?? [];
    const deviceIds = prioritizeDeviceIds(this.detectDeviceIds(), requestedTopics);
    if (!deviceIds.length) {
      this.log(`Skipping ${request.name}: no device list response was decoded.`);
      return;
    }

    this.log(`Reading ${deviceIds.length} detected device group(s): ${deviceIds.map(formatAddress).join(', ')}`);
    for (const deviceId of deviceIds) {
      const payload = this.buildReadGroupFrame(deviceId);
      this.log(`Sending read-group-${formatAddress(deviceId).slice(2)} (${payload.length} bytes)`);
      await this.sendFrame(payload);
      await delay(this.timings.pipelineSettleMs);
      if (requestedTopics.length && this.hasDecodedAllTopics(requestedTopics)) {
        this.log(`Found requested topic(s), stopping detected group scan: ${requestedTopics.join(', ')}.`);
        break;
      }
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

  hasDecodedAllTopics(topicNames: string[]) {
    const missing = new Set(topicNames);
    for (const response of this.getResponseBuffers()) {
      for (const topic of decodedTopicNames(response)) missing.delete(topic);
      if (missing.size === 0) return true;
    }
    return false;
  }

  applyClientAddress(payload: Buffer, mode: ReadRequest['addressMode']) {
    if (!mode || this.clientAddress === null) return payload;

    const rewritten = Buffer.from(payload);
    if (mode === 'source-client' || mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 2);
    if (mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 0);
    this.log(`Applied client address ${formatAddress(this.clientAddress)} using mode ${mode}.`);
    return rewritten;
  }

  async flushCurrentResponse({ incomplete = false }: { incomplete?: boolean } = {}): Promise<Buffer | null> {
    if (!this.currentChunks.length) return null;
    this.clearIdleTimer();
    const response = Buffer.concat(this.currentChunks);
    this.currentChunks = [];
    this.currentExpectedLength = null;
    this.responseBuffers.push(response);
    this.learnClientAddress(response);
    this.log(`Flushed ${incomplete ? 'incomplete ' : ''}response payload (${response.length} bytes): ${response.toString('hex')}`);
    await this.control.write(Buffer.from([0xf0, 0x01]), false).catch((error) => {
      this.log(`Could not acknowledge response payload: ${error.message}`);
    });
    if (this.pendingResponseCount > 0) this.pendingResponseCount -= 1;
    this.log(`Response acknowledged; pending response count is ${this.pendingResponseCount}.`);
    this.markDrainActivity();
    this.resolveDrainWaiters();
    return response;
  }

  getResponseBuffers() {
    const responses = this.responseBuffers.slice();
    if (this.currentChunks.length && (this.currentExpectedLength === null || this.currentResponseReachedExpectedLength())) responses.push(Buffer.concat(this.currentChunks));
    return responses;
  }

  clearCollectedResponses() {
    this.responseBuffers.length = 0;
    this.currentChunks = [];
    this.currentExpectedLength = null;
    this.announcedResponseLengths = [];
  }

  close() {
    this.clearIdleTimer();
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
    this.resolveDrainWaiters();
  }

  private waitForDrainProgress(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        this.drainResolvers = this.drainResolvers.filter((candidate) => candidate !== waiter);
        resolve();
      };
      const timeout = setTimeout(waiter, Math.max(0, timeoutMs));
      this.drainResolvers.push(waiter);
    });
  }

  private resolveDrainWaiters() {
    const resolvers = this.drainResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  private markDrainActivity() {
    this.drainActivityCounter += 1;
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
      const waiter: { expectedHex: string; resolve: () => void } = {
        expectedHex,
        resolve: () => {
          cleanup();
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for control notification ${expectedHex}.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.controlWaiters = this.controlWaiters.filter((candidate) => candidate !== waiter);
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

function prioritizeDeviceIds(deviceIds: number[], topicNames: string[]) {
  const hintedGroups = topicNames.flatMap((topicName) => TOPIC_GROUP_HINTS.get(topicName) ?? []);
  const priority = new Set(hintedGroups);
  return [
    ...hintedGroups.filter((group, index) => deviceIds.includes(group) && hintedGroups.indexOf(group) === index),
    ...deviceIds.filter((deviceId) => !priority.has(deviceId))
  ];
}

function decodedTopicNames(response: Buffer): string[] {
  const decoded = decodeFirstCbor(response);
  const candidate = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;
  if (!isRecord(candidate)) return [];
  if (typeof candidate.tn === 'string' && candidate.pn) return [candidate.tn];
  if (!Array.isArray(candidate.topics)) return [];
  return candidate.topics.flatMap((topic) => (isRecord(topic) && typeof topic.tn === 'string' && Array.isArray(topic.parameters) ? [topic.tn] : []));
}

function responseHasLastMessage(response: Buffer): boolean {
  const decoded = decodeFirstCbor(response);
  const candidate = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;
  return isRecord(candidate) && candidate.LastMessage === 1;
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

  return declaredBodyLength + 7;
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
