import { setTimeout as delay } from 'node:timers/promises';

import { decodeFirstCbor } from './cbor.js';
import { READ_SEQUENCE } from './constants.js';

const DEFAULT_TIMINGS = {
  responseIdleMs: 700,
  readyTimeoutMs: 1500,
  acceptedTimeoutMs: 1500,
  interleavedResponseSettleMs: 80,
  pipelineSettleMs: 0,
  finalDrainMs: 2500
};

export class TrumaProtocol {
  constructor(characteristics, { debug = false, timings = {} } = {}) {
    this.control = characteristics.control;
    this.write = characteristics.write;
    this.data = characteristics.data;
    this.debug = debug;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.responseBuffers = [];
    this.currentChunks = [];
    this.idleResolvers = [];
    this.controlWaiters = [];
    this.pendingResponseCount = 0;
    this.clientAddress = null;
    this.idleTimer = null;
    this.isStarted = false;
  }

  async start() {
    if (this.isStarted) return;
    this.debugLog('Subscribing to control and data characteristics.');
    this.control.onData((data) => this.handleControlNotification(data));
    this.data.onData((data) => this.handleDataNotification(data));

    await this.control.subscribe();
    this.debugLog('Control characteristic subscribed.');
    await this.data.subscribe();
    this.debugLog('Data characteristic subscribed.');
    this.isStarted = true;
  }

  async triggerPairingOnly() {
    this.debugLog('Installing control notification handler.');
    this.control.onData((data) => {
      this.debugLog(`Control notification: ${data.toString('hex')}`);
      this.handleControlNotification(data);
    });
    this.debugLog('Subscribing to protected control characteristic. This should write 01 00 to its CCCD.');
    await this.control.subscribe();
    this.debugLog('Control subscription call completed.');
  }

  async readAll({ sequence = READ_SEQUENCE } = {}) {
    await this.start();

    for (const request of sequence) {
      if (request.dynamic === 'device-groups') {
        await this.readDetectedDeviceGroups(request.name);
        continue;
      }

      const payload = request.build ? request.build() : Buffer.from(request.hex, 'hex');
      console.log(`Sending ${request.name} (${payload.length} bytes)`);
      await this.sendFrame(payload, request);
      await delay(this.timings.pipelineSettleMs);
    }

    await delay(this.timings.finalDrainMs);
    await this.drainPendingResponseAtEnd();
    await this.flushCurrentResponse();
    return this.responseBuffers;
  }

  async sendFrame(payload, request = {}) {
    const announce = Buffer.from([0x01, payload.length & 0xff, (payload.length >> 8) & 0xff]);
    this.debugLog(`Writing control announce: ${announce.toString('hex')}`);
    const ready = this.waitForControlNotification('8100', this.timings.readyTimeoutMs);
    await this.control.write(announce, false);
    await ready;
    await this.drainPendingResponseBeforeNextPayload();
    payload = this.applyClientAddress(payload, request.addressMode);
    this.debugLog(`Writing data frame (${payload.length} bytes): ${payload.toString('hex')}`);
    const accepted = this.waitForControlNotification('f001', this.timings.acceptedTimeoutMs);
    await this.write.write(payload, true);
    await accepted;
  }

  handleControlNotification(data) {
    const hex = data.toString('hex');
    this.debugLog(`Control notification: ${hex}`);
    this.resolveControlWaiters(hex);

    if (data.length >= 1 && data[0] === 0x83) {
      // Device has a response ready. The official app sends 03 00 promptly,
      // but it may announce the next frame before this response data arrives.
      this.pendingResponseCount += 1;
      this.control.write(Buffer.from([0x03, 0x00]), false).catch((error) => {
        console.warn(`Could not request response payload: ${error.message}`);
      });
      return;
    }

    if (hex === 'f001') {
      this.bumpIdle();
    }
  }

  handleDataNotification(data) {
    this.debugLog(`Data notification (${data.length} bytes): ${data.toString('hex')}`);
    this.currentChunks.push(Buffer.from(data));
    this.bumpIdle();
  }

  bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.handleIdleTimeout(), this.timings.responseIdleMs);
  }

  waitForIdle(timeoutMs) {
    return new Promise((resolve) => {
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
        this.debugLog('Flushing interleaved response before writing next data frame.');
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

  async readDetectedDeviceGroups(name) {
    await this.drainPendingResponseAtEnd();
    const deviceIds = this.detectDeviceIds();
    if (!deviceIds.length) {
      console.log(`Skipping ${name}: no device list response was decoded.`);
      return;
    }

    console.log(`Reading ${deviceIds.length} detected device group(s): ${deviceIds.map(formatAddress).join(', ')}`);
    for (const deviceId of deviceIds) {
      const payload = this.buildReadGroupFrame(deviceId);
      console.log(`Sending read-group-${formatAddress(deviceId).slice(2)} (${payload.length} bytes)`);
      await this.sendFrame(payload);
      await delay(this.timings.pipelineSettleMs);
    }
  }

  detectDeviceIds() {
    const deviceIds = [];

    for (const response of this.responseBuffers) {
      const decoded = decodeFirstCbor(response);
      const candidate = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;
      if (!candidate || !Array.isArray(candidate.Devices)) continue;

      for (const value of candidate.Devices) {
        if (Number.isInteger(value) && value >= 0 && value <= 0xffff) deviceIds.push(value);
      }
    }

    return [...new Set(deviceIds)];
  }

  buildReadGroupFrame(deviceId) {
    const payload = Buffer.from('000000050b00030000000000000000000400', 'hex');
    payload.writeUInt16LE(deviceId, 0);
    if (this.clientAddress !== null) payload.writeUInt16LE(this.clientAddress, 2);
    return payload;
  }

  applyClientAddress(payload, mode) {
    if (!mode || this.clientAddress === null) return payload;

    const rewritten = Buffer.from(payload);
    if (mode === 'source-client' || mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 2);
    if (mode === 'client-local') rewritten.writeUInt16LE(this.clientAddress, 0);
    this.debugLog(`Applied client address ${formatAddress(this.clientAddress)} using mode ${mode}.`);
    return rewritten;
  }

  async flushCurrentResponse() {
    if (!this.currentChunks.length) return;
    const response = Buffer.concat(this.currentChunks);
    this.currentChunks = [];
    this.responseBuffers.push(response);
    this.learnClientAddress(response);
    this.debugLog(`Flushed response payload (${response.length} bytes): ${response.toString('hex')}`);
    await this.control.write(Buffer.from([0xf0, 0x01]), false).catch((error) => {
      console.warn(`Could not acknowledge response payload: ${error.message}`);
    });
    if (this.pendingResponseCount > 0) this.pendingResponseCount -= 1;
  }

  learnClientAddress(response) {
    if (this.clientAddress !== null) return;

    const decoded = decodeFirstCbor(response);
    if (!decoded || !Number.isInteger(decoded.addr)) return;

    this.clientAddress = decoded.addr;
    console.log(`Using assigned Truma client address ${formatAddress(this.clientAddress)}.`);
  }

  waitForControlNotification(expectedHex, timeoutMs) {
    return new Promise((resolve, reject) => {
      let waiter;
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

  resolveControlWaiters(hex) {
    const waiters = this.controlWaiters.slice();
    for (const waiter of waiters) {
      if (waiter.expectedHex === hex) waiter.resolve();
    }
  }

  debugLog(message) {
    if (this.debug) console.log(`[protocol] ${message}`);
  }
}

function formatAddress(address) {
  return `0x${address.toString(16).padStart(4, '0')}`;
}
