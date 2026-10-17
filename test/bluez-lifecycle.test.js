import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { connectToTruma, disconnectQuietly, get, TRUMA } from '../dist/index.js';

const require = createRequire(import.meta.url);
const dbus = require('dbus-next');
const devicePath = '/org/bluez/hci0/dev_FC_A8_9B_57_E6_C1';
const canonical = (uuid) => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

async function mockBluez({ paired = true, setupError = false, notifyError = false }, run) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalBus = dbus.systemBus;
  const calls = [];
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
  }, on() {} };
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
  try { await run(calls); }
  finally { dbus.systemBus = originalBus; Object.defineProperty(process, 'platform', originalPlatform); }
}
const options = { bluetooth: 'bluez', adapter: 'hci0', deviceAddress: 'FC:A8:9B:57:E6:C1' };

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
