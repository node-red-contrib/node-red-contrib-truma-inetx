import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemTimeFrame, utcOffsetMinutes, decodeFirstCbor, validateParameterValue, validatePairingCode, createBluezAgentInterface } from '../dist/index.js';
import { findBluezAdapterPath, listBluezAdapters, matchesBluezDevice } from '../dist/ble/selection.js';

const objects = {
  '/org/bluez/hci1': { 'org.bluez.Adapter1': { Address: { value: 'BB:BB:BB:BB:BB:BB' }, Powered: { value: true } } },
  '/org/bluez/hci0': { 'org.bluez.Adapter1': { Address: { value: 'AA:AA:AA:AA:AA:AA' }, Powered: { value: false } } }
};

test('adapter selection supports MAC, hci name and path without fallback on a missing selection', () => {
  assert.deepEqual(listBluezAdapters(objects).map((adapter) => adapter.name), ['hci0', 'hci1']);
  for (const selector of ['bb:bb:bb:bb:bb:bb', 'hci1', '/org/bluez/hci1']) {
    assert.equal(findBluezAdapterPath(objects, selector), '/org/bluez/hci1');
  }
  assert.equal(findBluezAdapterPath(objects), '/org/bluez/hci0');
  assert.throws(() => findBluezAdapterPath(objects, 'hci2'), /not found/);
  assert.equal(findBluezAdapterPath({}), null);
});

test('device matching isolates adapters and treats the selected MAC as authoritative', () => {
  const filter = { adapterPath: '/org/bluez/hci1', namePrefix: 'Truma', deviceName: 'Old name', deviceAddress: 'CC:CC:CC:CC:CC:CC' };
  const device = { Name: { value: 'New name' }, Address: { value: 'cc:cc:cc:cc:cc:cc' } };
  assert.equal(matchesBluezDevice('/org/bluez/hci1/dev_CC', device, filter), true);
  assert.equal(matchesBluezDevice('/org/bluez/hci0/dev_CC', device, filter), false);
  assert.equal(matchesBluezDevice('/org/bluez/hci10/dev_CC', device, filter), false);
  assert.equal(matchesBluezDevice('/org/bluez/hci1/dev_AA', { ...device, Address: 'AA' }, filter), false);
});

test('SystemTime uses UTC epoch and the local offset including DST and fractional hours', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');
  for (const [zone, january, july] of [['Europe/Berlin', 60, 120], ['Pacific/Auckland', 780, 720], ['America/New_York', -300, -240], ['Asia/Kathmandu', 345, 345], ['UTC', 0, 0]]) {
    assert.equal(utcOffsetMinutes(winter, zone), january);
    assert.equal(utcOffsetMinutes(summer, zone), july);
    const params = decodeFirstCbor(buildSystemTimeFrame(winter, zone)).topics[0].parameters;
    assert.equal(params.find((parameter) => parameter.pn === 'Lot').v, january);
    assert.equal(params.find((parameter) => parameter.pn === 'Time').v, winter.getTime() / 1000);
  }
  assert.equal(utcOffsetMinutes(winter), -winter.getTimezoneOffset() || 0);
  assert.throws(() => utcOffsetMinutes(winter, 'Invalid/Zone'), RangeError);
});

test('write validation honors normalized and raw metadata without coercing types', () => {
  validateParameterValue(220, { min: 50, max: 300 });
  validateParameterValue(null, undefined);
  assert.throws(() => validateParameterValue(undefined), /requires a value/);
  assert.throws(() => validateParameterValue(NaN), /finite/);
  assert.throws(() => validateParameterValue('220', { min: 50 }), /numeric/);
  assert.throws(() => validateParameterValue(301, { max: 300 }), /at most/);
  assert.throws(() => validateParameterValue(49, { min: 50 }), /at least/);
  for (const metadata of [{ available: 0 }, { avail: false }]) assert.throws(() => validateParameterValue(1, metadata), /unavailable/);
  for (const metadata of [{ enum: [{ value: 0, available: 1 }, { value: 1, available: 0 }] }, { enum: [{ v: 0, a: 1 }, { v: 1, a: 0 }] }]) {
    validateParameterValue(0, metadata);
    assert.throws(() => validateParameterValue(1, metadata), /enum/);
    assert.throws(() => validateParameterValue('0', metadata), /enum/);
  }
});

test('pairing agent preserves leading zeroes, checks confirmation and rejects other devices', () => {
  class Interface { static configureMembers() {} }
  const logs = [];
  const Agent = createBluezAgentInterface(Interface, (line) => logs.push(line), '/selected', '001234');
  const agent = new Agent();
  assert.equal(agent.RequestPinCode('/selected'), '001234');
  assert.equal(agent.RequestPasskey('/selected'), 1234);
  agent.RequestConfirmation('/selected', 1234);
  assert.throws(() => agent.RequestConfirmation('/selected', 5678), /does not match/);
  assert.throws(() => agent.RequestPasskey('/other'), /different device/);
  assert.throws(() => agent.AuthorizeService('/other', 'service'), /different device/);
  agent.DisplayPasskey('/selected', 1234, 0);
  assert.equal(logs.some((line) => line.includes('1234')), false);
  const NoCodeAgent = createBluezAgentInterface(Interface, () => {}, '/selected');
  assert.throws(() => new NoCodeAgent().RequestPasskey('/selected'), /six-digit code/);
  for (const code of ['12345', '1234567', '12abcd', 123456, null]) assert.throws(() => validatePairingCode(code), /six digits/);
});
