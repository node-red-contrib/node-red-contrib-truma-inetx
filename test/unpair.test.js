import assert from 'node:assert/strict';
import test from 'node:test';
import { removeBluezDevice } from '../dist/ble/unpair.js';

const address = 'FC:A8:9B:57:E6:C1';
function fixture(fail = false, afterRemove = () => {}) {
  const calls = [];
  const objects = {
    '/org/bluez/hci0': { 'org.bluez.Adapter1': { Address: { value: '00:00:00:00:00:00' } } },
    '/org/bluez/hci1': { 'org.bluez.Adapter1': { Address: { value: '11:11:11:11:11:11' } } }
  };
  for (const adapter of ['hci0', 'hci1']) {
    objects[`/org/bluez/${adapter}/selected`] = { 'org.bluez.Device1': { Address: { value: address }, Name: { value: 'Truma same name' } } };
    objects[`/org/bluez/${adapter}/other`] = { 'org.bluez.Device1': { Address: { value: 'AA:BB:CC:DD:EE:FF' }, Name: { value: 'Truma same name' } } };
  }
  const bus = {
    async getProxyObject(service, path) {
      assert.equal(service, 'org.bluez');
      return { getInterface(name) {
        if (name === 'org.freedesktop.DBus.ObjectManager') return { GetManagedObjects: async () => objects };
        assert.equal(name, 'org.bluez.Adapter1');
        return { RemoveDevice: async (device) => {
          calls.push([path, device]);
          if (fail) throw new Error('Permission denied');
          if (!objects[device]) throw new Error('Unknown device');
          delete objects[device];
          afterRemove(objects);
        } };
      } };
    },
    disconnect() { calls.push('disconnected'); }
  };
  return { bus, calls, objects };
}

test('forget removes every cached object for the selected identity, including unpaired duplicates', async () => {
  const { bus, calls, objects } = fixture();
  objects['/org/bluez/hci1/selected']['org.bluez.Device1'].Paired = { value: true };
  objects['/org/bluez/hci1/old_random_path'] = { 'org.bluez.Device1': { Address: { value: address.toLowerCase() }, Paired: { value: false } } };
  await removeBluezDevice(bus, { adapter: 'hci1', deviceAddress: address });
  assert.deepEqual(calls, [
    ['/org/bluez/hci1', '/org/bluez/hci1/selected'],
    ['/org/bluez/hci1', '/org/bluez/hci1/old_random_path'],
    'disconnected'
  ]);
});

test('forget removes only the exact address on the explicit adapter, then closes D-Bus', async () => {
  const { bus, calls } = fixture();
  const result = await removeBluezDevice(bus, { adapter: '11:11:11:11:11:11', deviceAddress: address.toLowerCase() });
  assert.equal(result.status, 'removed');
  assert.deepEqual(calls, [['/org/bluez/hci1', '/org/bluez/hci1/selected'], 'disconnected']);
});

test('forget succeeds if BlueZ removes an associated cached object together with the identity', async () => {
  const duplicate = '/org/bluez/hci1/old_random_path';
  const { bus, objects } = fixture(false, (objects) => { delete objects[duplicate]; });
  objects[duplicate] = { 'org.bluez.Device1': { Address: { value: address } } };
  assert.equal((await removeBluezDevice(bus, { adapter: 'hci1', deviceAddress: address })).status, 'removed');
  assert.equal(objects[duplicate], undefined);
});

test('forget never falls back to another adapter, name or device', async () => {
  for (const options of [
    { adapter: '', deviceAddress: address },
    { adapter: 'hci0', deviceAddress: 'Truma same name' },
    { adapter: 'hci9', deviceAddress: address }
  ]) {
    const { bus, calls } = fixture();
    await assert.rejects(removeBluezDevice(bus, options));
    assert.deepEqual(calls, ['disconnected']);
  }
  const { bus, calls } = fixture();
  assert.equal((await removeBluezDevice(bus, { adapter: 'hci0', deviceAddress: '00:11:22:33:44:55' })).status, 'not-found');
  assert.deepEqual(calls, ['disconnected']);
});

test('forget reports RemoveDevice failures and still closes D-Bus', async () => {
  const { bus, calls } = fixture(true);
  await assert.rejects(removeBluezDevice(bus, { adapter: 'hci0', deviceAddress: address }), /Permission denied/);
  assert.equal(calls.at(-1), 'disconnected');
});
