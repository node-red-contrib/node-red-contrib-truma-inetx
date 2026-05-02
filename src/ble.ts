import { setTimeout as delay } from 'node:timers/promises';

import nobleModule from '@abandonware/noble';

import { TRUMA } from './constants.js';
import type { TrumaCharacteristic, TrumaCharacteristics } from './protocol.js';

const noble = (nobleModule as { default?: unknown }).default ?? nobleModule;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 1200;
const DISCONNECT_TIMEOUT_MS = 3000;

type Noble = any;
type Peripheral = any;
type Characteristic = any;
type Logger = (message: string) => void;

export interface TrumaSession {
  peripheral: Peripheral;
  characteristics: TrumaCharacteristics;
}

export interface ConnectOptions {
  namePrefix?: string;
  scanServiceUuid?: string | null;
  matchServiceUuid?: string | null;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  discoverTimeoutMs?: number;
  connectRetries?: number;
  logger?: Logger;
}

let activePeripheral: Peripheral | null = null;

export async function connectToTruma({
  namePrefix = TRUMA.advertisedNamePrefix,
  scanServiceUuid = null,
  matchServiceUuid = TRUMA.advertisedServiceUuid,
  timeoutMs = 30000,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  discoverTimeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS,
  connectRetries = DEFAULT_CONNECT_RETRIES,
  logger = () => {}
}: ConnectOptions = {}): Promise<TrumaSession> {
  await waitForPoweredOn();
  logger('Bluetooth adapter powered on.');
  logger(`Scan matcher: namePrefix=${namePrefix}, advertisedService=${matchServiceUuid || '<disabled>'}, nobleServiceFilter=${scanServiceUuid || '<none>'}.`);

  const peripheral = await scanAndConnectWithRetry({
    namePrefix,
    scanServiceUuid,
    matchServiceUuid,
    attempts: connectRetries,
    scanTimeoutMs: timeoutMs,
    connectTimeoutMs,
    logger
  });

  activePeripheral = peripheral;
  logger('Discovering services and characteristics.');
  const { characteristics } = await discoverAllAsync(peripheral, discoverTimeoutMs);
  const byUuid = new Map<string, Characteristic>(characteristics.map((characteristic: Characteristic) => [normalizeUuid(characteristic.uuid), characteristic]));
  logger(`Discovered ${characteristics.length} characteristic(s): ${[...byUuid.keys()].sort().join(', ')}.`);

  const control = byUuid.get(TRUMA.controlUuid);
  const write = byUuid.get(TRUMA.writeUuid);
  const data = byUuid.get(TRUMA.dataUuid);
  const extraNotify = byUuid.get(TRUMA.extraNotifyUuid);
  const softwareRevision = byUuid.get(TRUMA.softwareRevisionUuid);

  if (!control || !write || !data) {
    const found = [...byUuid.keys()].sort().join(', ');
    throw new Error(`Missing Truma characteristics. Found: ${found}`);
  }
  logger(`Control characteristic properties: ${(control.properties || []).join(',') || '<none>'}.`);
  logger(`Write characteristic properties: ${(write.properties || []).join(',') || '<none>'}.`);
  logger(`Data characteristic properties: ${(data.properties || []).join(',') || '<none>'}.`);
  if (extraNotify) logger(`Extra notify characteristic properties: ${(extraNotify.properties || []).join(',') || '<none>'}.`);

  return {
    peripheral,
    characteristics: {
      control: wrapCharacteristic(control),
      write: wrapCharacteristic(write),
      data: wrapCharacteristic(data),
      extraNotify: extraNotify ? wrapCharacteristic(extraNotify) : null,
      softwareRevision: softwareRevision ? wrapCharacteristic(softwareRevision) : null
    }
  };
}

export async function readSoftwareRevision(characteristics: TrumaCharacteristics): Promise<string | null> {
  if (!characteristics.softwareRevision) return null;
  const value = await characteristics.softwareRevision.read();
  return value.toString('utf8') || null;
}

export async function disconnectQuietly(peripheral: Peripheral | null | undefined): Promise<void> {
  if (!peripheral || peripheral.state === 'disconnected') return;
  try {
    await disconnectAsync(peripheral, DISCONNECT_TIMEOUT_MS);
  } catch {
    // Best effort cleanup only.
  }
}

export async function shutdownBluetooth(): Promise<void> {
  (noble as Noble).removeAllListeners('discover');
  await stopScanningAndWait();
  await disconnectQuietly(activePeripheral);
  activePeripheral = null;
}

async function waitForPoweredOn(): Promise<void> {
  if ((noble as Noble).state === 'poweredOn') return;
  if ((noble as Noble).state === 'unsupported' || (noble as Noble).state === 'unauthorized') {
    throw new Error(`Bluetooth adapter state is ${(noble as Noble).state}.`);
  }

  return new Promise((resolve, reject) => {
    const onStateChange = (state: string) => {
      if (state === 'poweredOn') {
        (noble as Noble).removeListener('stateChange', onStateChange);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        (noble as Noble).removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth adapter state is ${state}.`));
      }
    };
    (noble as Noble).on('stateChange', onStateChange);
  });
}

async function scanAndConnectWithRetry({
  namePrefix,
  scanServiceUuid,
  matchServiceUuid,
  attempts,
  scanTimeoutMs,
  connectTimeoutMs,
  logger
}: {
  namePrefix: string;
  scanServiceUuid: string | null;
  matchServiceUuid: string | null;
  attempts: number;
  scanTimeoutMs: number;
  connectTimeoutMs: number;
  logger: Logger;
}): Promise<Peripheral> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger(`Scanning and connecting (attempt ${attempt}/${attempts}).`);
    try {
      return await scanAndConnect({ namePrefix, scanServiceUuid, matchServiceUuid, scanTimeoutMs, connectTimeoutMs, logger });
    } catch (error) {
      lastError = error;
      logger(`Connect attempt ${attempt} failed: ${errorMessage(error)}.`);
      if (attempt < attempts) await delay(RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function scanAndConnect({
  namePrefix,
  scanServiceUuid,
  matchServiceUuid,
  scanTimeoutMs,
  connectTimeoutMs,
  logger
}: {
  namePrefix: string;
  scanServiceUuid: string | null;
  matchServiceUuid: string | null;
  scanTimeoutMs: number;
  connectTimeoutMs: number;
  logger: Logger;
}): Promise<Peripheral> {
  return new Promise((resolve, reject) => {
    let candidate: Peripheral | null = null;
    let connecting = false;
    let settled = false;

    const finish = async (error?: Error | null, peripheral?: Peripheral | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(scanTimeout);
      (noble as Noble).removeListener('discover', onDiscover);
      await stopScanningAndWait();
      if (error) {
        if (candidate) await disconnectQuietly(candidate);
        reject(error);
      } else {
        resolve(peripheral);
      }
    };

    const scanTimeout = setTimeout(() => {
      finish(new Error(`Timed out after ${scanTimeoutMs}ms while scanning for ${namePrefix}.`)).catch(reject);
    }, scanTimeoutMs);

    const onDiscover = (peripheral: Peripheral) => {
      if (connecting) return;
      if (!isTrumaPeripheral(peripheral, { namePrefix, serviceUuid: matchServiceUuid })) return;

      connecting = true;
      candidate = peripheral;
      activePeripheral = peripheral;
      logger(`Found ${displayPeripheral(peripheral)}.`);

      connectAsync(peripheral, connectTimeoutMs, logger)
        .then(() => finish(null, peripheral))
        .catch((error) => finish(asError(error)).catch(reject));
    };

    (noble as Noble).on('discover', onDiscover);
    startScanning(scanServiceUuid, (error?: Error) => {
      if (error) finish(error).catch(reject);
    });
  });
}

export function isTrumaPeripheral(
  peripheral: {
    advertisement?: {
      localName?: string;
      serviceUuids?: string[];
    };
  },
  {
    namePrefix = TRUMA.advertisedNamePrefix,
    serviceUuid = TRUMA.advertisedServiceUuid
  }: {
    namePrefix?: string;
    serviceUuid?: string | null;
  } = {}
): boolean {
  const name = peripheral.advertisement?.localName || '';
  if (name.startsWith(namePrefix)) return true;

  if (!serviceUuid) return false;
  const expectedServiceUuid = normalizeUuid(serviceUuid);
  const advertisedServices = peripheral.advertisement?.serviceUuids || [];
  return advertisedServices.some((uuid) => normalizeUuid(uuid) === expectedServiceUuid);
}

function startScanning(scanServiceUuid: string | null, callback: (error?: Error) => void): void {
  const services = scanServiceUuid ? [scanServiceUuid] : [];
  (noble as Noble).startScanning(services, true, callback);
}

function stopScanningAndWait(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      (noble as Noble).removeListener('scanStop', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    (noble as Noble).once('scanStop', finish);
    (noble as Noble).stopScanning();
  });
}

function discoverAllAsync(peripheral: Peripheral, timeoutMs: number): Promise<{ services: unknown[]; characteristics: Characteristic[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms while discovering GATT services.`));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timeout);

    peripheral.discoverAllServicesAndCharacteristics((error: Error | null, services: unknown[], characteristics: Characteristic[]) => {
      cleanup();
      if (error) reject(error);
      else resolve({ services, characteristics });
    });
  });
}

function connectAsync(peripheral: Peripheral, timeoutMs: number, logger: Logger): Promise<void> {
  if (peripheral.state === 'connected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger(`Connect finished after ${Date.now() - startedAt}ms with ${error ? `error: ${error.message}` : 'success'}.`);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      cancelPendingConnect(peripheral, logger);
      finish(new Error(`Timed out after ${timeoutMs}ms while connecting.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      peripheral.removeListener('connect', onConnect);
      peripheral.removeListener('disconnect', onDisconnect);
    };

    const onConnect = (error?: Error | string | null) => finish(asNullableError(error));
    const onDisconnect = () => finish(new Error('Peripheral disconnected before connect completed.'));

    peripheral.once('connect', onConnect);
    peripheral.once('disconnect', onDisconnect);
    peripheral.connect((error?: Error | string | null) => finish(asNullableError(error)));
  });
}

function cancelPendingConnect(peripheral: Peripheral, logger: Logger): void {
  if (peripheral.state !== 'connecting') return;
  try {
    if (typeof (noble as Noble)._bindings?.cancelConnect === 'function' && typeof peripheral.cancelConnect === 'function') {
      peripheral.cancelConnect();
      return;
    }
    if (typeof (noble as Noble)._bindings?.disconnect === 'function') {
      (noble as Noble)._bindings.disconnect(peripheral.id);
    }
  } catch (error) {
    logger(`Could not cancel pending connection: ${errorMessage(error)}.`);
  }
}

function disconnectAsync(peripheral: Peripheral, timeoutMs = DISCONNECT_TIMEOUT_MS): Promise<void> {
  if (peripheral.state === 'disconnected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs}ms while disconnecting.`)), timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      peripheral.removeListener('disconnect', onDisconnect);
    };

    const onDisconnect = () => finish();

    peripheral.once('disconnect', onDisconnect);
    peripheral.disconnect((error?: Error | null) => finish(error));
  });
}

function wrapCharacteristic(characteristic: Characteristic): TrumaCharacteristic {
  return {
    uuid: normalizeUuid(characteristic.uuid),
    properties: characteristic.properties || [],
    read() {
      return new Promise((resolve, reject) => {
        characteristic.read((error: Error | null, data: Buffer) => (error ? reject(error) : resolve(data)));
      });
    },
    write(data: Buffer, withoutResponse = false) {
      return new Promise((resolve, reject) => {
        characteristic.write(data, withoutResponse, (error: Error | null) => (error ? reject(error) : resolve()));
      });
    },
    subscribe() {
      return new Promise((resolve, reject) => {
        characteristic.subscribe((error: Error | null) => (error ? reject(error) : resolve()));
      });
    },
    onData(listener: (data: Buffer) => void) {
      characteristic.on('data', (data: Buffer) => listener(data));
    }
  };
}

function normalizeUuid(uuid: string): string {
  return String(uuid).toLowerCase().replaceAll('-', '');
}

function displayPeripheral(peripheral: Peripheral): string {
  const name = peripheral.advertisement?.localName || '<unnamed>';
  return `${name} (${peripheral.address || peripheral.id}, ${peripheral.addressType || 'unknown'}, connectable=${peripheral.connectable}, rssi=${peripheral.rssi})`;
}

function asNullableError(error: Error | string | null | undefined): Error | null {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
