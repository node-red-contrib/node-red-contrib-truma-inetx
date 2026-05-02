import { setTimeout as delay } from 'node:timers/promises';

import nobleModule from '@abandonware/noble';

import { TRUMA } from './constants.js';

const noble = nobleModule.default ?? nobleModule;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 1200;
const DISCONNECT_TIMEOUT_MS = 3000;
const POST_SCAN_SETTLE_MS = 350;
const DEFAULT_WARMUP_SCAN_MS = 0;
let activePeripheral = null;
let nobleDiagnosticsInstalled = false;

export async function connectToTruma({
  namePrefix = TRUMA.advertisedNamePrefix,
  scanServiceUuid = null,
  timeoutMs = 30000,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  discoverTimeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS,
  connectRetries = DEFAULT_CONNECT_RETRIES,
  warmupScanMs = DEFAULT_WARMUP_SCAN_MS,
  resetBeforeConnect = false,
  connectDuringScan = true,
  debug = false
} = {}) {
  installNobleDiagnostics(debug);
  warnIfUnsupportedNode(debug);
  debugLog(debug, 'Step 1/5: waiting for Bluetooth adapter to be powered on.');
  await waitForPoweredOn();
  debugLog(debug, `Bluetooth adapter powered on. noble backend=${noble._bindings?.constructor?.name || 'unknown'}`);

  if (resetBeforeConnect && typeof noble._bindings?.reset === 'function') {
    console.log('Resetting noble adapter state before scan...');
    noble.reset();
    await delay(1000);
    await waitForPoweredOn();
  } else if (resetBeforeConnect) {
    console.log('Adapter reset is not supported by the active noble backend; continuing without reset.');
  }

  if (warmupScanMs > 0) {
    debugLog(debug, 'Step 2/5: warmup scan before connecting.');
    console.log(`Warming up scan for ${warmupScanMs}ms...`);
    const seen = await scanForMatchingPeripherals({ namePrefix, scanServiceUuid, timeoutMs: warmupScanMs });
    logScanSummary(seen);
  }

  debugLog(debug, 'Step 3/5: scanning for Truma and opening BLE connection.');
  const peripheral = connectDuringScan
    ? await scanAndConnectWithRetry({
      namePrefix,
      scanServiceUuid,
      attempts: connectRetries,
      scanTimeoutMs: timeoutMs,
      connectTimeoutMs,
      debug
    })
    : await scanThenConnectWithRetry({
      namePrefix,
      scanServiceUuid,
      attempts: connectRetries,
      scanTimeoutMs: timeoutMs,
      connectTimeoutMs,
      debug
    });
  activePeripheral = peripheral;
  peripheral.once('disconnect', () => console.log('Disconnected from Truma iNet X.'));

  debugLog(debug, 'Step 4/5: discovering GATT services and characteristics.');
  console.log('Discovering services and characteristics...');
  const { characteristics } = await discoverAllAsync(peripheral, discoverTimeoutMs);
  const byUuid = new Map(characteristics.map((characteristic) => [normalizeUuid(characteristic.uuid), characteristic]));
  debugLog(debug, `Discovered ${characteristics.length} characteristic(s): ${[...byUuid.keys()].sort().join(', ')}`);

  const control = byUuid.get(TRUMA.controlUuid);
  const write = byUuid.get(TRUMA.writeUuid);
  const data = byUuid.get(TRUMA.dataUuid);
  const extraNotify = byUuid.get(TRUMA.extraNotifyUuid);
  const softwareRevision = byUuid.get(TRUMA.softwareRevisionUuid);

  if (!control || !write || !data) {
    const found = [...byUuid.keys()].sort().join(', ');
    throw new Error(`Missing Truma characteristics. Found: ${found}`);
  }
  debugLog(debug, 'Step 5/5: required Truma characteristics are present.');

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

export async function scanTruma({
  namePrefix = TRUMA.advertisedNamePrefix,
  scanServiceUuid = null,
  timeoutMs = 10000
} = {}) {
  await waitForPoweredOn();
  const seen = await scanForMatchingPeripherals({ namePrefix, scanServiceUuid, timeoutMs });
  logScanSummary(seen);
  return seen;
}

export async function readSoftwareRevision(characteristics) {
  if (!characteristics.softwareRevision) return null;
  console.log('[pair-debug] Reading software revision characteristic 0x2a28.');
  const value = await characteristics.softwareRevision.read();
  const revision = value.toString('utf8');
  console.log(`[pair-debug] Software revision value: ${revision || '<empty>'}`);
  return revision;
}

export async function disconnectQuietly(peripheral) {
  if (!peripheral || peripheral.state === 'disconnected') return;
  try {
    await disconnectAsync(peripheral, DISCONNECT_TIMEOUT_MS);
  } catch {
    // Ignore shutdown errors; the process is already winding down.
  }
}

export async function shutdownBluetooth() {
  noble.removeAllListeners('discover');
  await stopScanningAndWait();
  await disconnectQuietly(activePeripheral);
  activePeripheral = null;
}

function waitForPoweredOn() {
  if (noble.state === 'poweredOn') return Promise.resolve();
  if (noble.state && noble.state !== 'unknown') {
    console.log(`Bluetooth adapter state is ${noble.state}; waiting for poweredOn...`);
  }
  return new Promise((resolve, reject) => {
    const onStateChange = (state) => {
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

function scanForPeripheral({ namePrefix, scanServiceUuid, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup().then(() => reject(new Error(`Timed out after ${timeoutMs}ms while scanning for ${namePrefix}.`))).catch(reject);
    }, timeoutMs);

    const cleanup = async () => {
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningAndWait();
    };

    const onDiscover = (peripheral) => {
      const name = peripheral.advertisement?.localName || '';
      if (!name.startsWith(namePrefix)) return;
      cleanup().then(() => resolve(peripheral)).catch(reject);
    };

    noble.on('discover', onDiscover);
    startScanning(scanServiceUuid, (error) => {
      if (error) {
        cleanup().then(() => reject(error)).catch(reject);
      }
    });
  });
}

function scanForMatchingPeripherals({ namePrefix, scanServiceUuid, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const seen = new Map();

    const timeout = setTimeout(() => {
      cleanup().then(() => resolve([...seen.values()])).catch(reject);
    }, timeoutMs);

    const cleanup = async () => {
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningAndWait();
    };

    const onDiscover = (peripheral) => {
      const name = peripheral.advertisement?.localName || '';
      if (!name.startsWith(namePrefix)) return;
      const previous = seen.get(peripheral.id);
      seen.set(peripheral.id, {
        peripheral,
        count: (previous?.count || 0) + 1,
        firstSeen: previous?.firstSeen || new Date(),
        lastSeen: new Date()
      });
    };

    noble.on('discover', onDiscover);
    startScanning(scanServiceUuid, (error) => {
      if (error) {
        cleanup().then(() => reject(error)).catch(reject);
      }
    });
  });
}

function startScanning(scanServiceUuid, callback) {
  const services = scanServiceUuid ? [scanServiceUuid] : [];
  if (services.length) console.log(`Scanning for advertised service ${scanServiceUuid}...`);
  else console.log('Scanning all BLE advertisements and matching by name...');
  noble.startScanning(services, true, callback);
}

function stopScanningAndWait() {
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

async function scanAndConnectWithRetry({ namePrefix, scanServiceUuid, attempts, scanTimeoutMs, connectTimeoutMs, debug }) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Scanning and connecting (attempt ${attempt}/${attempts})...`);
    try {
      return await scanAndConnect({ namePrefix, scanServiceUuid, scanTimeoutMs, connectTimeoutMs, debug });
    } catch (error) {
      lastError = error;
      console.warn(`Connect attempt ${attempt} failed: ${error.message}`);
      if (attempt < attempts) await delay(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function scanThenConnectWithRetry({ namePrefix, scanServiceUuid, attempts, scanTimeoutMs, connectTimeoutMs, debug }) {
  const peripheral = await scanForPeripheral({ namePrefix, scanServiceUuid, timeoutMs: scanTimeoutMs });
  console.log(`Found ${displayPeripheral(peripheral)}.`);
  await delay(POST_SCAN_SETTLE_MS);
  await connectWithRetry(peripheral, { attempts, timeoutMs: connectTimeoutMs, debug });
  return peripheral;
}

async function connectWithRetry(peripheral, { attempts, timeoutMs, debug }) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Connecting (attempt ${attempt}/${attempts})...`);
    try {
      await connectAsync(peripheral, timeoutMs, debug);
      console.log('Connected.');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Connect attempt ${attempt} failed: ${error.message}`);
      await disconnectQuietly(peripheral);
      if (attempt < attempts) await delay(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

function scanAndConnect({ namePrefix, scanServiceUuid, scanTimeoutMs, connectTimeoutMs, debug }) {
  return new Promise((resolve, reject) => {
    let candidate = null;
    let connecting = false;
    let settled = false;

    const finish = async (error, peripheral = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(scanTimeout);
      noble.removeListener('discover', onDiscover);
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

    const onDiscover = (peripheral) => {
      if (connecting) return;
      const name = peripheral.advertisement?.localName || '';
      if (!name.startsWith(namePrefix)) return;

      connecting = true;
      candidate = peripheral;
      activePeripheral = peripheral;
      console.log(`Found ${displayPeripheral(peripheral)}.`);
      console.log('Connecting while scan is still active...');

      connectAsync(peripheral, connectTimeoutMs, debug)
        .then(() => {
          console.log('Connected.');
          return finish(null, peripheral);
        })
        .catch((error) => finish(error).catch(reject));
    };

    noble.on('discover', onDiscover);
    startScanning(scanServiceUuid, (error) => {
      if (error) finish(error).catch(reject);
    });
  });
}

function discoverAllAsync(peripheral, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms while discovering GATT services.`));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timeout);

    peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
      cleanup();
      if (error) reject(error);
      else resolve({ services, characteristics });
    });
  });
}

function connectAsync(peripheral, timeoutMs, debug = false) {
  if (peripheral.state === 'connected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      debugLog(debug, `Connect finished after ${Date.now() - startedAt}ms with ${error ? `error: ${error.message}` : 'success'}. state=${peripheral.state}`);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      debugLog(debug, `Connect timeout reached. state=${peripheral.state}; attempting to cancel/cleanup pending CoreBluetooth connection.`);
      cancelPendingConnect(peripheral);
      finish(new Error(`Timed out after ${timeoutMs}ms while connecting.`));
    }, timeoutMs);

    const progress = setInterval(() => {
      debugLog(debug, `Still waiting for connect event... elapsed=${Date.now() - startedAt}ms state=${peripheral.state}`);
    }, 3000);

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(progress);
      peripheral.removeListener('connect', onConnect);
      peripheral.removeListener('disconnect', onDisconnect);
    };

    const onConnect = (error) => {
      debugLog(debug, `Peripheral emitted connect. error=${error ? error.message || error : '<none>'} state=${peripheral.state}`);
      finish(error instanceof Error ? error : error ? new Error(String(error)) : null);
    };
    const onDisconnect = (reason) => {
      debugLog(debug, `Peripheral emitted disconnect before connect completed. reason=${reason || '<none>'}`);
      finish(new Error('Peripheral disconnected before connect completed.'));
    };

    peripheral.once('connect', onConnect);
    peripheral.once('disconnect', onDisconnect);

    debugLog(debug, `Calling peripheral.connect(). id=${peripheral.id} state=${peripheral.state}`);
    peripheral.connect((error) => {
      debugLog(debug, `peripheral.connect callback fired. error=${error ? error.message || error : '<none>'} state=${peripheral.state}`);
      finish(error instanceof Error ? error : error ? new Error(String(error)) : null);
    });
  });
}

function cancelPendingConnect(peripheral) {
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
    console.warn(`Could not cancel pending connection: ${error.message}`);
  }
}

function disconnectAsync(peripheral, timeoutMs = DISCONNECT_TIMEOUT_MS) {
  if (peripheral.state === 'disconnected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
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
    peripheral.disconnect((error) => finish(error));
  });
}

function wrapCharacteristic(characteristic) {
  return {
    uuid: normalizeUuid(characteristic.uuid),
    properties: characteristic.properties || [],
    raw: characteristic,
    read() {
      return new Promise((resolve, reject) => {
        characteristic.read((error, data) => (error ? reject(error) : resolve(data)));
      });
    },
    write(data, withoutResponse = false) {
      return new Promise((resolve, reject) => {
        characteristic.write(data, withoutResponse, (error) => (error ? reject(error) : resolve()));
      });
    },
    subscribe() {
      return new Promise((resolve, reject) => {
        characteristic.subscribe((error) => (error ? reject(error) : resolve()));
      });
    },
    onData(listener) {
      characteristic.on('data', listener);
    }
  };
}

function normalizeUuid(uuid) {
  return String(uuid).toLowerCase().replaceAll('-', '');
}

function displayPeripheral(peripheral) {
  const name = peripheral.advertisement?.localName || '<unnamed>';
  return `${name} (${peripheral.address || peripheral.id}, ${peripheral.addressType || 'unknown'}, connectable=${peripheral.connectable}, rssi=${peripheral.rssi})`;
}

function debugLog(debug, message) {
  if (debug) console.log(`[pair-debug] ${message}`);
}

function installNobleDiagnostics(debug) {
  if (!debug || nobleDiagnosticsInstalled) return;
  nobleDiagnosticsInstalled = true;
  noble.on('warning', (message) => console.warn(`[pair-debug] noble warning: ${message}`));
  noble.on('scanStart', () => debugLog(debug, 'noble emitted scanStart.'));
  noble.on('scanStop', () => debugLog(debug, 'noble emitted scanStop.'));
  noble.on('stateChange', (state) => debugLog(debug, `noble emitted stateChange=${state}.`));
}

function warnIfUnsupportedNode(debug) {
  if (!debug) return;
  const major = Number(process.versions.node.split('.')[0]);
  if (major > 22) {
    console.warn(`[pair-debug] Warning: Node ${process.versions.node} is newer than the native noble macOS backend is known to handle reliably. If connect never completes, retry with Node 22 LTS.`);
  }
}

function logScanSummary(seen) {
  if (!seen.length) {
    console.log('No matching Truma advertisements seen.');
    return;
  }

  console.log(`Saw ${seen.length} matching Truma peripheral id(s):`);
  for (const entry of seen) {
    const { peripheral, count } = entry;
    const advertisement = peripheral.advertisement || {};
    const manufacturer = advertisement.manufacturerData ? advertisement.manufacturerData.toString('hex') : '';
    const services = Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids.join(',') : '';
    const state = trumaAdvertisementState(manufacturer);
    console.log(`- ${displayPeripheral(peripheral)} adverts=${count} mfg=${manufacturer || '-'} state=${state} services=${services || '-'}`);
  }
}

function trumaAdvertisementState(manufacturerHex) {
  if (manufacturerHex.startsWith('730c0001')) return 'pairing-or-ble-active';
  if (manufacturerHex.startsWith('730c0000')) return 'normal-not-pairing';
  return 'unknown';
}
