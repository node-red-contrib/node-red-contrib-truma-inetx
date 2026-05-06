import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

import type { Noble, NobleCharacteristic, NoblePeripheral } from '@abandonware/noble';

import { TRUMA } from './constants.js';
import type { BluetoothBackend, BluetoothBackendName, ResolvedConnectOptions } from './ble/backend.js';
import type { TrumaCharacteristic, TrumaCharacteristics } from './protocol.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 1200;
const DISCONNECT_TIMEOUT_MS = 3000;

type Peripheral = NoblePeripheral;
type Characteristic = NobleCharacteristic;
type Logger = (message: string) => void;
type BluezObjects = Record<string, Record<string, Record<string, unknown>>>;
type BluezVariantConstructor = new (signature: string, value: unknown) => unknown;
export type { BluetoothBackendName };

const requireOptional = createRequire(import.meta.url);

async function loadNoble(): Promise<Noble> {
  if (noble) return noble;
  nobleImportPromise ??= import('@abandonware/noble').then((module) => module.default);
  noble = await nobleImportPromise;
  return noble;
}

function getLoadedNoble(): Noble {
  if (!noble) throw new Error('Noble Bluetooth backend has not been initialized.');
  return noble;
}

export interface TrumaSession {
  peripheral: Peripheral | BluezPeripheral;
  characteristics: TrumaCharacteristics;
}

interface BluezPeripheral {
  bluez: true;
  state: 'connected' | 'disconnected';
  disconnect(): Promise<void>;
}

export interface ConnectOptions {
  bluetooth?: BluetoothBackendName;
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
let activeBluezSession: TrumaSession | null = null;
let noble: Noble | null = null;
let nobleImportPromise: Promise<Noble> | null = null;

const nobleBackend: BluetoothBackend = {
  name: 'noble',
  isAvailable: async () => true,
  connect: connectToTrumaNoble,
  shutdown: shutdownNoble
};

const bluezBackend: BluetoothBackend = {
  name: 'bluez',
  isAvailable: isBluezAvailable,
  connect: connectToTrumaBluez,
  shutdown: shutdownBluez
};

export async function connectToTruma({
  bluetooth = 'auto',
  namePrefix = TRUMA.advertisedNamePrefix,
  scanServiceUuid = null,
  matchServiceUuid = TRUMA.advertisedServiceUuid,
  timeoutMs = 30000,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  discoverTimeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS,
  connectRetries = DEFAULT_CONNECT_RETRIES,
  logger = () => {}
}: ConnectOptions = {}): Promise<TrumaSession> {
  const backend = await selectBluetoothBackend(bluetooth, logger);
  return backend.connect({ namePrefix, scanServiceUuid, matchServiceUuid, timeoutMs, connectTimeoutMs, discoverTimeoutMs, connectRetries, logger });
}

async function connectToTrumaNoble({
  namePrefix,
  scanServiceUuid,
  matchServiceUuid,
  timeoutMs,
  connectTimeoutMs,
  discoverTimeoutMs,
  connectRetries,
  logger
}: ResolvedConnectOptions): Promise<TrumaSession> {
  await loadNoble();
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

async function selectBluetoothBackend(bluetooth: BluetoothBackendName, logger: Logger): Promise<BluetoothBackend> {
  if (bluetooth === 'bluez') return bluezBackend;
  if (bluetooth === 'noble') return nobleBackend;
  if (await bluezBackend.isAvailable(logger)) return bluezBackend;
  return nobleBackend;
}

export async function isBluezAvailable(logger: Logger = () => {}): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { systemBus } = loadDbusNext();
    const bus = systemBus();
    try {
      const object = await bus.getProxyObject('org.bluez', '/');
      const objectManager = object.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
      const objects = await objectManager.GetManagedObjects();
      return findBluezAdapterPath(objects) !== null;
    } finally {
      bus.disconnect();
    }
  } catch (error) {
    logger(`BlueZ backend is not available for auto bluetooth selection: ${errorMessage(error)}.`);
    return false;
  }
}

export async function readSoftwareRevision(characteristics: TrumaCharacteristics): Promise<string | null> {
  if (!characteristics.softwareRevision) return null;
  const value = await characteristics.softwareRevision.read();
  return value.toString('utf8') || null;
}

export async function disconnectQuietly(peripheral: Peripheral | BluezPeripheral | null | undefined): Promise<void> {
  if (isBluezPeripheral(peripheral)) {
    await peripheral.disconnect();
    if (activeBluezSession?.peripheral === peripheral) activeBluezSession = null;
    return;
  }
  if (!peripheral || peripheral.state === 'disconnected') return;
  try {
    await disconnectAsync(peripheral, DISCONNECT_TIMEOUT_MS);
  } catch {
    // Best effort cleanup only.
  }
}

export async function shutdownBluetooth(): Promise<void> {
  await Promise.all([nobleBackend.shutdown(), bluezBackend.shutdown()]);
}

async function shutdownNoble(): Promise<void> {
  if (!noble) return;
  noble.removeAllListeners('discover');
  await stopScanningAndWait();
  await disconnectQuietly(activePeripheral);
  activePeripheral = null;
}

async function shutdownBluez(): Promise<void> {
  await disconnectQuietly(activeBluezSession?.peripheral);
  activeBluezSession = null;
}

async function waitForPoweredOn(): Promise<void> {
  const noble = getLoadedNoble();
  if (noble.state === 'poweredOn') return;
  if (noble.state === 'unsupported' || noble.state === 'unauthorized') {
    throw new Error(`Bluetooth adapter state is ${noble.state}.`);
  }

  return new Promise((resolve, reject) => {
    const onStateChange = (state: string) => {
      if (state === 'poweredOn') {
        noble.removeListener('stateChange', onStateChange);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth adapter state is ${state}.`));
      }
    };
    noble.on('stateChange', onStateChange);
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
  const noble = getLoadedNoble();
  return new Promise((resolve, reject) => {
    let candidate: Peripheral | null = null;
    let connecting = false;
    let settled = false;

    const finish = async (error?: Error | null, peripheral?: Peripheral | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(scanTimeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningAndWait();
      if (error) {
        if (candidate) await disconnectQuietly(candidate);
        reject(error);
      } else if (peripheral) {
        resolve(peripheral);
      } else {
        reject(new Error('Connect completed without a peripheral.'));
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

    noble.on('discover', onDiscover);
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
  const noble = getLoadedNoble();
  const services = scanServiceUuid ? [scanServiceUuid] : [];
  noble.startScanning(services, true, callback);
}

function stopScanningAndWait(): Promise<void> {
  const noble = getLoadedNoble();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('scanStop', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    noble.once('scanStop', finish);
    noble.stopScanning();
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
  const noble = getLoadedNoble();
  if (peripheral.state !== 'connecting') return;
  try {
    if (typeof noble._bindings?.cancelConnect === 'function' && typeof peripheral.cancelConnect === 'function') {
      peripheral.cancelConnect();
      return;
    }
    if (typeof noble._bindings?.disconnect === 'function') {
      noble._bindings.disconnect(peripheral.id);
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

async function connectToTrumaBluez({
  namePrefix,
  matchServiceUuid,
  timeoutMs,
  connectTimeoutMs,
  discoverTimeoutMs,
  logger
}: {
  namePrefix: string;
  matchServiceUuid: string | null;
  timeoutMs: number;
  connectTimeoutMs: number;
  discoverTimeoutMs: number;
  logger: Logger;
}): Promise<TrumaSession> {
  if (process.platform !== 'linux') throw new Error('BlueZ backend is only available on Linux.');
  const { systemBus, Variant } = loadDbusNext();
  const bus = systemBus();
  const normalizedServiceUuid = matchServiceUuid ? normalizeUuid(matchServiceUuid) : undefined;
  const canonicalServiceUuid = normalizedServiceUuid ? formatCanonicalUuid(normalizedServiceUuid) : undefined;

  try {
    const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
    const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
    const objects = await objectManager.GetManagedObjects();
    const adapterPath = findBluezAdapterPath(objects);
    if (!adapterPath) throw new Error('Could not find a BlueZ adapter via org.bluez ObjectManager.');
    logger('Bluetooth adapter powered on.');
    logger(`BlueZ backend using adapter ${adapterPath}.`);

    const adapterObject = await bus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObject.getInterface('org.bluez.Adapter1') as BluezAdapter;
    await setBluezDiscoveryFilter(adapter, Variant, canonicalServiceUuid, logger);
    await adapter.StartDiscovery();
    logger(`BlueZ discovery started. Waiting up to ${timeoutMs}ms for ${namePrefix}.`);

    let device: { path: string; address: string | null };
    try {
      device = await waitForBluezDevice({ objectManager, initialObjects: objects, namePrefix, serviceUuid: canonicalServiceUuid, timeoutMs, logger });
    } finally {
      await adapter.StopDiscovery().catch((error: unknown) => logger(`Warning: could not stop BlueZ discovery: ${errorMessage(error)}`));
    }

    logger(`BlueZ connecting to ${device.address || '<unknown address>'} at ${device.path}.`);
    const deviceObject = await bus.getProxyObject('org.bluez', device.path);
    const bluezDevice = deviceObject.getInterface('org.bluez.Device1') as BluezDevice;
    const deviceProperties = deviceObject.getInterface('org.freedesktop.DBus.Properties') as BluezProperties;
    if (!(await getBluezBoolean(deviceProperties, 'org.bluez.Device1', 'Connected'))) {
      await withTimeout(bluezDevice.Connect(), connectTimeoutMs, 'BlueZ Device1.Connect()');
    }
    await waitForBluezBooleanProperty(deviceProperties, 'org.bluez.Device1', 'ServicesResolved', true, discoverTimeoutMs);
    logger('BlueZ connected and services resolved.');

    const refreshed = await objectManager.GetManagedObjects();
    const characteristics = await buildBluezCharacteristics({ bus, objects: refreshed, devicePath: device.path, logger });
    const session: TrumaSession = {
      peripheral: {
        bluez: true,
        state: 'connected',
        disconnect: async () => {
          await bluezDevice.Disconnect().catch(() => {});
          bus.disconnect();
        }
      },
      characteristics
    };
    activeBluezSession = session;
    return session;
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}

function normalizeUuid(uuid: string): string {
  const compact = String(uuid).toLowerCase().replaceAll('-', '');
  if (compact.length === 32 && compact.startsWith('0000') && compact.endsWith('00001000800000805f9b34fb')) return compact.slice(4, 8);
  return compact;
}

async function buildBluezCharacteristics({
  bus,
  objects,
  devicePath,
  logger
}: {
  bus: BluezBus;
  objects: BluezObjects;
  devicePath: string;
  logger: Logger;
}): Promise<TrumaCharacteristics> {
  const byUuid = new Map<string, { path: string; properties: Record<string, unknown> }>();

  for (const [path, interfaces] of Object.entries(objects)) {
    if (!path.startsWith(`${devicePath}/`)) continue;
    const characteristic = interfaces['org.bluez.GattCharacteristic1'];
    if (!characteristic) continue;
    const uuid = nullableString(unboxBluezValue(characteristic.UUID));
    if (!uuid) continue;
    byUuid.set(normalizeUuid(uuid), { path, properties: characteristic });
  }

  logger(`BlueZ discovered ${byUuid.size} GATT characteristic(s): ${[...byUuid.keys()].sort().join(', ')}.`);
  const control = byUuid.get(TRUMA.controlUuid);
  const write = byUuid.get(TRUMA.writeUuid);
  const data = byUuid.get(TRUMA.dataUuid);
  const extraNotify = byUuid.get(TRUMA.extraNotifyUuid);
  const softwareRevision = byUuid.get(TRUMA.softwareRevisionUuid);
  if (!control || !write || !data) {
    throw new Error(`Missing Truma characteristics via BlueZ. Found: ${[...byUuid.keys()].sort().join(', ')}`);
  }

  return {
    control: await wrapBluezCharacteristic(bus, control.path, control.properties),
    write: await wrapBluezCharacteristic(bus, write.path, write.properties),
    data: await wrapBluezCharacteristic(bus, data.path, data.properties),
    extraNotify: extraNotify ? await wrapBluezCharacteristic(bus, extraNotify.path, extraNotify.properties) : null,
    softwareRevision: softwareRevision ? await wrapBluezCharacteristic(bus, softwareRevision.path, softwareRevision.properties) : null
  };
}

async function wrapBluezCharacteristic(bus: BluezBus, path: string, initialProperties: Record<string, unknown>): Promise<TrumaCharacteristic> {
  const object = await bus.getProxyObject('org.bluez', path);
  const characteristic = object.getInterface('org.bluez.GattCharacteristic1') as BluezCharacteristic;
  const properties = object.getInterface('org.freedesktop.DBus.Properties') as BluezProperties;
  const listeners = new Set<(data: Buffer) => void>();
  const flags = Array.isArray(unboxBluezValue(initialProperties.Flags)) ? (unboxBluezValue(initialProperties.Flags) as unknown[]).map(String) : [];
  let writeQueue = Promise.resolve();

  properties.on('PropertiesChanged', (interfaceName: string, changed: Record<string, unknown>) => {
    if (interfaceName !== 'org.bluez.GattCharacteristic1' || !('Value' in changed)) return;
    const value = Buffer.from((unboxBluezValue(changed.Value) as number[]) || []);
    for (const listener of listeners) listener(value);
  });

  return {
    uuid: normalizeUuid(String(unboxBluezValue(initialProperties.UUID) || '')),
    properties: flags,
    async read() {
      const value = await characteristic.ReadValue({});
      return Buffer.from(value);
    },
    async write(data: Buffer, withoutResponse = false) {
      const options = withoutResponse ? { type: new (loadDbusNext().Variant)('s', 'command') } : {};
      writeQueue = writeQueue.then(() => writeBluezValueWithRetry(characteristic, [...data], options));
      await writeQueue;
    },
    async subscribe() {
      await characteristic.StartNotify();
    },
    onData(listener: (data: Buffer) => void) {
      listeners.add(listener);
    }
  };
}

function loadDbusNext(): { systemBus: () => BluezBus; Variant: BluezVariantConstructor } {
  try {
    return requireOptional('dbus-next') as { systemBus: () => BluezBus; Variant: BluezVariantConstructor };
  } catch (error) {
    throw new Error(`BlueZ backend requires the optional "dbus-next" dependency. Run npm install. ${errorMessage(error)}`);
  }
}

interface BluezBus {
  getProxyObject(service: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  disconnect(): void;
}

interface BluezObjectManager {
  GetManagedObjects(): Promise<BluezObjects>;
  on(event: 'InterfacesAdded', listener: (path: string, interfaces: Record<string, Record<string, unknown>>) => void): void;
  off(event: 'InterfacesAdded', listener: (path: string, interfaces: Record<string, Record<string, unknown>>) => void): void;
}

interface BluezAdapter {
  StartDiscovery(): Promise<void>;
  StopDiscovery(): Promise<void>;
  SetDiscoveryFilter(filter: Record<string, unknown>): Promise<void>;
}

interface BluezDevice {
  Connect(): Promise<void>;
  Disconnect(): Promise<void>;
}

interface BluezCharacteristic {
  ReadValue(options: Record<string, unknown>): Promise<number[]>;
  WriteValue(value: number[], options: Record<string, unknown>): Promise<void>;
  StartNotify(): Promise<void>;
}

interface BluezProperties {
  Get(interfaceName: string, propertyName: string): Promise<unknown>;
  on(event: 'PropertiesChanged', listener: (interfaceName: string, changed: Record<string, unknown>, invalidated: string[]) => void): void;
}

function findBluezAdapterPath(objects: BluezObjects): string | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    if (interfaces['org.bluez.Adapter1']) return path;
  }
  return null;
}

async function setBluezDiscoveryFilter(adapter: BluezAdapter, Variant: BluezVariantConstructor, serviceUuid: string | undefined, logger: Logger): Promise<void> {
  const filters: Array<{ name: string; filter: Record<string, unknown> }> = [
    { name: 'transport', filter: { Transport: new Variant('s', 'le') } },
    { name: 'duplicates', filter: { DuplicateData: new Variant('b', false) } }
  ];
  if (serviceUuid) filters.push({ name: 'service UUID', filter: { UUIDs: new Variant('as', [serviceUuid]) } });

  for (const { name, filter } of filters) {
    await adapter.SetDiscoveryFilter(filter)
      .then(() => logger(`BlueZ discovery filter applied: ${name}.`))
      .catch((error: unknown) => logger(`Warning: could not set BlueZ discovery filter (${name}): ${errorMessage(error)}`));
  }
}

async function waitForBluezDevice({
  objectManager,
  initialObjects,
  namePrefix,
  serviceUuid,
  timeoutMs,
  logger
}: {
  objectManager: BluezObjectManager;
  initialObjects: BluezObjects;
  namePrefix: string;
  serviceUuid: string | undefined;
  timeoutMs: number;
  logger: Logger;
}): Promise<{ path: string; address: string | null }> {
  const initialMatch = findBluezDevice(initialObjects, { namePrefix, serviceUuid });
  if (initialMatch) return initialMatch;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      objectManager.off('InterfacesAdded', onInterfacesAdded);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ to discover ${namePrefix}.`));
    }, timeoutMs);
    const onInterfacesAdded = (path: string, interfaces: Record<string, Record<string, unknown>>) => {
      const match = findBluezDevice({ [path]: interfaces }, { namePrefix, serviceUuid });
      if (!match) return;
      clearTimeout(timeout);
      objectManager.off('InterfacesAdded', onInterfacesAdded);
      logger(`BlueZ InterfacesAdded matched ${namePrefix} at ${path}.`);
      resolve(match);
    };
    objectManager.on('InterfacesAdded', onInterfacesAdded);
  });
}

function findBluezDevice(objects: BluezObjects, { namePrefix, serviceUuid }: { namePrefix: string; serviceUuid: string | undefined }): { path: string; address: string | null } | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    const device = interfaces['org.bluez.Device1'];
    if (!device) continue;
    const name = String(unboxBluezValue(device.Name) || unboxBluezValue(device.Alias) || '');
    const address = nullableString(unboxBluezValue(device.Address));
    const uuids = Array.isArray(unboxBluezValue(device.UUIDs)) ? (unboxBluezValue(device.UUIDs) as unknown[]).map((uuid) => String(uuid).toLowerCase()) : [];
    if (name.startsWith(namePrefix)) return { path, address };
    if (serviceUuid && uuids.includes(serviceUuid.toLowerCase())) return { path, address };
  }
  return null;
}

async function getBluezBoolean(properties: BluezProperties, interfaceName: string, propertyName: string): Promise<boolean | null> {
  const value = await properties.Get(interfaceName, propertyName).catch(() => null);
  const unboxed = unboxBluezValue(value);
  return typeof unboxed === 'boolean' ? unboxed : null;
}

async function waitForBluezBooleanProperty(properties: BluezProperties, interfaceName: string, propertyName: string, expected: boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getBluezBoolean(properties, interfaceName, propertyName)) === expected) return;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ ${propertyName}=${expected}.`);
}

function formatCanonicalUuid(uuid: string): string {
  const compact = normalizeUuid(uuid);
  if (compact.length === 4) return `0000${compact}-0000-1000-8000-00805f9b34fb`;
  if (compact.length !== 32) return uuid.toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function writeBluezValueWithRetry(characteristic: BluezCharacteristic, value: number[], options: Record<string, unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await characteristic.WriteValue(value, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isBluezInProgressError(error)) throw error;
      await delay(80);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isBluezInProgressError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('in progress') || message.includes('inprogress');
}

function unboxBluezValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value as { value: unknown }).value;
  return value;
}

function isBluezPeripheral(peripheral: unknown): peripheral is { bluez: true; disconnect(): Promise<void> } {
  return !!peripheral && typeof peripheral === 'object' && (peripheral as { bluez?: unknown }).bluez === true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms during ${label}.`)), timeoutMs);
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
