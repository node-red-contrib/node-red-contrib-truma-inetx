import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { connectToTruma, disconnectQuietly, discover, get, TrumaConnection, TrumaProtocol, TRUMA } from '../dist/index.js';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const dbus = require('dbus-next');
const devicePath = '/org/bluez/hci0/dev_FC_A8_9B_57_E6_C1';
const canonical = (uuid) => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

async function mockBluez({ paired = true, setupError = false, notifyError = false }, run) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalBus = dbus.systemBus;
  const calls = [];
  const propertyListeners = [];
  const objects = {
    '/org/bluez/hci0': { 'org.bluez.Adapter1': { Address: '11:22:33:44:55:66' } },
    [devicePath]: { 'org.bluez.Device1': { Address: 'FC:A8:9B:57:E6:C1', Name: 'Truma iNetX-test' } }
  };
  for (const [index, uuid] of [TRUMA.controlUuid, TRUMA.writeUuid, TRUMA.dataUuid].entries()) {
    objects[`${devicePath}/service/char${index}`] = { 'org.bluez.GattCharacteristic1': { UUID: canonical(uuid), Flags: ['write', 'notify'] } };
  }
  const device = { Connect: async () => { calls.push('connect'); }, Disconnect: async () => { calls.push('disconnect'); } };
  const properties = { Get: async (_, property) => {
    if (setupError && property === 'ServicesResolved') throw new Error('Service discovery failed');
    return { value: property === 'Paired' ? paired : property === 'ServicesResolved' };
  }, on(_event, listener) { propertyListeners.push(listener); } };
  dbus.systemBus = () => ({
    async getProxyObject(_, path) {
      return { getInterface(name) {
        if (name === 'org.freedesktop.DBus.ObjectManager') return { GetManagedObjects: async () => objects, on() {}, off() {} };
        if (name === 'org.bluez.Adapter1') return { SetDiscoveryFilter: async () => {}, StartDiscovery: async () => {}, StopDiscovery: async () => {} };
        if (name === 'org.bluez.Device1') return device;
        if (name === 'org.freedesktop.DBus.Properties') return properties;
        if (name === 'org.bluez.GattCharacteristic1') return { ReadValue: async () => [], WriteValue: async () => {}, StartNotify: async () => { if (notifyError) throw new Error("Notification subscription failed"); } };
        throw new Error(`Unexpected ${path} ${name}`);
      } };
    },
    disconnect() { calls.push('close-bus'); }
  });
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { await run(calls, (connected) => propertyListeners.forEach((listener) => listener('org.bluez.Device1', { Connected: { value: connected } }, []))); }
  finally { dbus.systemBus = originalBus; Object.defineProperty(process, 'platform', originalPlatform); }
}
const options = { bluetooth: 'bluez', adapter: 'hci0', deviceAddress: 'FC:A8:9B:57:E6:C1' };

test('idle mode reuses the session, clears old responses, and closes only after the most recent request', async () => {
  await mockBluez({}, async (calls) => {
    const scheduled = [];
    const connection = new TrumaConnection(1000, async (cleanup) => { scheduled.push(cleanup); });
    try {
      const first = await connection.acquire(options);
      first.protocol.responseBuffers.push(Buffer.from('old'));
      await connection.release(true);
      await delay(1100);
      assert.equal(scheduled.length, 1);
      const next = await connection.acquire(options);
      assert.equal(next.session, first.session);
      assert.equal(next.protocol, first.protocol);
      assert.equal(next.protocol.getResponseBuffers().length, 0);
      await scheduled.shift()(); // Expired cleanup queued behind the new request must not close it.
      assert.deepEqual(calls, ['connect']);
      await connection.release(true);
      await delay(1100);
      await scheduled.shift()();
      assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
    } finally { await connection.close(); }
  });
});

test('failed reads close retained sessions immediately and the next request reconnects', async () => {
  await mockBluez({ notifyError: true }, async (calls) => {
    const connection = new TrumaConnection(60000, (cleanup) => cleanup());
    try {
      await assert.rejects(get({ ...options, connection }), /Notification subscription failed/);
      assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
      await assert.rejects(get({ ...options, connection }), /Notification subscription failed/);
      assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus', 'connect', 'disconnect', 'close-bus']);
    } finally { await connection.close(); }
  });
});

test('a remote disconnect invalidates a retained session before the next request', async () => {
  await mockBluez({}, async (calls, changed) => {
    const connection = new TrumaConnection(60000, (cleanup) => cleanup());
    try {
      const first = await connection.acquire(options);
      await connection.release(true);
      changed(false);
      assert.equal(first.session.peripheral.state, 'disconnected');
      const next = await connection.acquire(options);
      assert.notEqual(next.session, first.session);
      assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus', 'connect']);
    } finally { await connection.close(); }
  });
});

test('successful library reads use one retained session and explicit close releases it once', async () => {
  const original = TrumaProtocol.prototype.readAll;
  TrumaProtocol.prototype.readAll = async () => [];
  try {
    await mockBluez({}, async (calls) => {
      const connection = new TrumaConnection(60000, (cleanup) => cleanup());
      try {
        await get({ ...options, connection });
        await get({ ...options, connection });
        assert.deepEqual(calls, ['connect']);
      } finally { await connection.close(); await connection.close(); }
      assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
    });
  } finally { TrumaProtocol.prototype.readAll = original; }
});

test('BlueZ disconnects the device before closing D-Bus when service setup fails', async () => {
  await mockBluez({ setupError: true }, async (calls) => {
    await assert.rejects(connectToTruma(options), /Service discovery failed/);
    assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
  });
});

test('BlueZ rejects unpaired reads without connecting and releases an existing link', async () => {
  await mockBluez({ paired: false }, async (calls) => {
    await assert.rejects(connectToTruma(options), /not paired.*click Pair/);
    assert.deepEqual(calls, ['disconnect', 'close-bus']);
  });
});

test('BlueZ successful sessions disconnect once and report disconnected state', async () => {
  await mockBluez({}, async (calls) => {
    const session = await connectToTruma(options);
    await disconnectQuietly(session.peripheral);
    await disconnectQuietly(session.peripheral);
    assert.equal(session.peripheral.state, 'disconnected');
    assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
  });
});

test('failed topic reads release the connected BlueZ session', async () => {
  await mockBluez({ notifyError: true }, async (calls) => {
    await assert.rejects(get(options), /Notification subscription failed/);
    assert.deepEqual(calls, ['connect', 'disconnect', 'close-bus']);
  });
});

test('topology-only discovery avoids group parameter reads while full library discovery remains available', async () => {
  const originalReadAll = TrumaProtocol.prototype.readAll;
  const sequences = [];
  TrumaProtocol.prototype.readAll = async ({ sequence }) => { sequences.push(sequence); return []; };
  try {
    await mockBluez({}, async () => {
      await discover({ ...options, topologyOnly: true });
      await discover(options);
    });
    assert.equal(sequences[0].some((request) => request.dynamic === 'device-groups'), false);
    assert.equal(sequences[0].some((request) => request.name === 'read-device-list'), true);
    assert.equal(sequences[1].some((request) => request.dynamic === 'device-groups'), true);
  } finally { TrumaProtocol.prototype.readAll = originalReadAll; }
});
