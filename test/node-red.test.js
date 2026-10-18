import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { validatePairingCode, validateUnpairOptions } from '../dist/index.js';

function register(filename, library = {}, devices = {}) {
  const types = {};
  const routes = {};
  const RED = {
    nodes: {
      createNode(node, config) {
        node.id = config.id;
        node.handlers = {};
        node.on = (event, handler) => { node.handlers[event] = handler; };
        node.status = (status) => { node.lastStatus = status; };
        node.error = (error) => { node.lastError = error; };
      },
      registerType: (type, constructor) => { types[type] = constructor; },
      getNode: (id) => devices[id]
    },
    auth: { needsPermission: (permission) => permission },
    httpAdmin: Object.fromEntries(['get', 'post'].map((method) => [method, (path, permission, handler) => { routes[`${method} ${path}`] = { permission, handler }; }]))
  };
  const sandbox = { module: { exports: {} }, fakeLibrary: library };
  // Substitute only the dynamic library import; execute the shipped node runtime.
  const code = readFileSync(new URL(`../nodes/${filename}`, import.meta.url), 'utf8').replace("import('../dist/index.js')", 'Promise.resolve(fakeLibrary)');
  runInNewContext(code, sandbox);
  sandbox.module.exports(RED);
  return { types, routes };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
}

const tree = { topics: { AirHeating: { group: '0x0201', parameters: { TgtTemp: { value: 200, min: 50, max: 300 } } } } };

test('cleared device selection survives deployment without discovering or connecting to another panel', async () => {
  let calls = 0;
  const { types } = register('truma-inetx-device.js', { discover: async () => { calls++; return tree; } });
  const device = new types['truma-inetx-device']({ targetMode: 'none', deviceAddress: '', deviceName: '' });
  await device.ready;
  assert.equal(device.lastStatus.text, 'no device selected');
  assert.throws(() => device.connectOptions(), /No Truma device selected/);
  await assert.rejects(device.refreshTree(), /No Truma device selected/);
  await assert.rejects(device.enqueue(() => { calls++; }), /No Truma device selected/);
  assert.equal(calls, 0);
});

test('device config passes adapter/timezone and retains validation metadata after value-only updates', async () => {
  let options;
  const { types } = register('truma-inetx-device.js', { discover: async (input) => { options = input; return tree; } });
  const device = new types['truma-inetx-device']({ adapter: 'hci1', timeZone: 'Europe/Berlin', targetMode: 'device', deviceAddress: 'AA:BB:CC:DD:EE:FF' });
  await device.ready;
  assert.equal(options.adapter, 'hci1');
  assert.equal(options.protocol.timeZone, 'Europe/Berlin');
  assert.equal(options.deviceAddress, 'AA:BB:CC:DD:EE:FF');
  assert.equal(options.topologyOnly, true);
  device.mergeTree({ topics: { AirHeating: { parameters: { TgtTemp: { value: 220 } } } } });
  assert.equal(device.tree.topics.AirHeating.parameters.TgtTemp.value, 220);
  assert.equal(device.tree.topics.AirHeating.parameters.TgtTemp.max, 300);
});

test('pair endpoint requires write permission, selected MAC and valid transient code', async () => {
  let options;
  const { routes } = register('truma-inetx-device.js', { validatePairingCode, pair: async (input) => { options = input; return { bluez: { paired: true } }; } });
  const route = routes['post /truma-inetx/pair'];
  assert.equal(route.permission, 'flows.write');
  for (const body of [{}, { deviceAddress: 'AA:BB:CC:DD:EE:FF', passkey: 'invalid' }]) {
    const res = response();
    await route.handler({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(options, undefined);
  }
  const res = response();
  await route.handler({ body: { deviceAddress: 'AA:BB:CC:DD:EE:FF', adapter: 'hci1', passkey: '001234' } }, res);
  assert.equal(options.passkey, '001234');
  assert.equal(options.adapter, 'hci1');
  assert.equal(options.linuxLegacyPairing, false);
  assert.equal(res.body.bluez.paired, true);
  assert.equal(JSON.stringify(res.body).includes('001234'), false);
});

test('editor searches and pairing share the queue with multiple device nodes; errors do not poison it', async () => {
  let active = 0;
  let maximum = 0;
  async function work(result) {
    maximum = Math.max(maximum, ++active);
    await delay(5);
    active--;
    return result;
  }
  const { types, routes } = register('truma-inetx-device.js', {
    discover: () => work(tree), discoverTrumaDevices: () => work([]), pair: () => work({ bluez: { paired: true } }), unpair: () => work({ status: 'removed' }), validatePairingCode, validateUnpairOptions
  });
  const first = new types['truma-inetx-device']({});
  const second = new types['truma-inetx-device']({});
  await Promise.all([
    first.ready, second.ready,
    routes['post /truma-inetx/unpair'].handler({ body: { adapter: 'hci0', deviceAddress: 'AA:BB:CC:DD:EE:FF' } }, response()),
    routes['get /truma-inetx/devices'].handler({ query: {} }, response()),
    routes['post /truma-inetx/pair'].handler({ body: { deviceAddress: 'AA:BB:CC:DD:EE:FF' } }, response())
  ]);
  assert.equal(maximum, 1);
  await assert.rejects(first.enqueue(async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await first.enqueue(() => work('recovered')), 'recovered');
});

test('set node forwards metadata and null values, and emits no success for an unconfirmed write', async () => {
  let received;
  let error;
  let emitted = false;
  const device = {
    connectOptions: () => ({}), groupForTopic: async () => 0x0201, logDebug() {}, mergeTree() {},
    enqueue: (operation) => operation({ set: async (options) => { received = options; throw Object.assign(new Error('Read back first'), { code: 'TRUMA_WRITE_UNCONFIRMED' }); } }, tree)
  };
  const { types } = register('truma-inetx-set.js', {}, { device });
  const node = new types['truma-inetx-set']({ device: 'device', topic: 'AirHeating', parameter: 'TgtTemp', value: '200' });
  await node.handlers.input({ payload: { value: null } }, () => { emitted = true; }, (failure) => { error = failure; });
  assert.equal(received.value, null);
  assert.equal(received.metadata.max, 300);
  assert.equal(error.code, 'TRUMA_WRITE_UNCONFIRMED');
  assert.equal(emitted, false);
  assert.equal(node.lastStatus.fill, 'yellow');
});

test('editor script parses and pairing code is not a persisted configuration field', () => {
  let definition;
  const html = readFileSync(new URL('../nodes/truma-inetx-device.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, { RED: { nodes: { registerType: (_name, options) => { definition = options; } } } });
  assert.equal(definition.defaults.adapter.value, '');
  assert.equal(definition.defaults.timeZone.validate('Europe/Berlin'), true);
  assert.equal(definition.defaults.timeZone.validate('Invalid/Zone'), false);
  assert.equal('pairingCode' in definition.defaults, false);
});

test('forget endpoint requires write permission and explicit adapter plus MAC', async () => {
  let options;
  const { routes } = register('truma-inetx-device.js', {
    validateUnpairOptions, unpair: async (input) => { options = input; return { status: 'removed' }; }
  });
  const route = routes['post /truma-inetx/unpair'];
  assert.equal(route.permission, 'flows.write');
  for (const body of [{}, { deviceAddress: 'AA:BB:CC:DD:EE:FF' }, { adapter: 'hci0', deviceAddress: 'Truma' }]) {
    const res = response();
    await route.handler({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(options, undefined);
  }
  const res = response();
  await route.handler({ body: { adapter: 'hci1', deviceAddress: 'AA:BB:CC:DD:EE:FF' } }, res);
  assert.equal(options.adapter, 'hci1');
  assert.equal(options.deviceAddress, 'AA:BB:CC:DD:EE:FF');
  assert.equal(res.body.status, 'removed');
});

test('missing topology after startup failure does not trigger redundant discovery before get', async () => {
  let attempts = 0;
  const { types } = register('truma-inetx-device.js', { discover: async () => { attempts++; throw new Error('Device unavailable'); } });
  const device = new types['truma-inetx-device']({});
  const missing = await device.ensureTopics(['AirHeating']);
  assert.equal(missing[0], 'AirHeating');
  assert.equal(attempts, 1);
  assert.equal(device.tree, null);
});

test('a topic read with an incomplete cached tree goes straight to get without a full rediscovery', async () => {
  let discoveries = 0;
  let reads = 0;
  const library = {
    discover: async () => { discoveries++; return { topicLists: ['AirHeating'], topics: {} }; },
    get: async (options) => {
      reads++;
      assert.deepEqual(Array.from(options.topics), ['AirHeating']);
      assert.equal(options.groups, undefined);
      return tree;
    }
  };
  const config = register('truma-inetx-device.js', library);
  const device = new config.types['truma-inetx-device']({});
  await device.ready;
  const flow = register('truma-inetx-get.js', {}, { device });
  const node = new flow.types['truma-inetx-get']({ device: 'device', topics: 'AirHeating' });
  let emitted;
  await node.handlers.input({ payload: 123 }, (msg) => { emitted = msg; }, (error) => { assert.ifError(error); });
  assert.equal(discoveries, 1);
  assert.equal(reads, 1);
  assert.equal(emitted.payload.topics.AirHeating.parameters.TgtTemp.value, 200);
});

test('write group lookup learns only the requested topic and retains its validation metadata', async () => {
  const reads = [];
  const { types } = register('truma-inetx-device.js', {
    discover: async () => ({ topicLists: ['AirHeating'], topics: {} }),
    get: async (options) => { reads.push(Array.from(options.topics)); return tree; }
  });
  const device = new types['truma-inetx-device']({});
  assert.equal(await device.groupForTopic('AirHeating'), 0x0201);
  assert.equal(await device.groupForTopic('AirHeating'), 0x0201);
  assert.deepEqual(reads, [['AirHeating']]);
  assert.equal(device.tree.topics.AirHeating.parameters.TgtTemp.max, 300);
});
