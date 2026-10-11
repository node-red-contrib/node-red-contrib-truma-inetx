import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const flow = JSON.parse(readFileSync(new URL('../examples/victron-temperatures.json', import.meta.url)));
const converter = flow.find((node) => node.id === 'truma-temp-convert');

test('Victron example converts fresh raw temperatures and disconnects missing, failed or stale readings', () => {
  const context = new Map();
  let now = 1000;
  const run = (msg) => runInNewContext(`(function() { ${converter.func} })()`, {
    msg, context: { get: (key) => context.get(key), set: (key, value) => context.set(key, value) },
    flow: { set() {} }, Date: { now: () => now }
  });
  const input = (room, water) => ({ payload: { topics: {
    AirHeating: { parameters: { Temp: { value: room } } }, WaterHeating: { parameters: { Temp: { value: water } } }
  } } });
  let result = run(input(215, 0));
  assert.equal(result[0][0].payload['/Temperature'], 21.5);
  assert.equal(result[1][0].payload['/Temperature'], 0);
  assert.equal(result[0][1].connected, true);
  now += 299999;
  assert.equal(run({ kind: 'tick' })[0], null);
  now++;
  assert.equal(run({ kind: 'tick' })[0].connected, false);
  result = run(input(null, 65535));
  assert.equal(result[0].connected, false);
  assert.equal(result[1].connected, false);
  result = run(input(180, 400));
  assert.equal(result[1][0].payload['/Temperature'], 40);
  assert.equal(run({ error: { message: 'read failed' } })[1].connected, false);
  const unavailable = input(200, 500);
  unavailable.payload.topics.AirHeating.parameters.Temp.available = 0;
  assert.equal(run(unavailable)[0].connected, false);
});

test('Victron example has complete wires and starts both sensors disconnected with no fake values', () => {
  const ids = new Set(flow.map((node) => node.id));
  for (const node of flow) for (const id of (node.wires || []).flat()) assert.equal(ids.has(id), true, id);
  const sensors = flow.filter((node) => node.type === 'victron-virtual');
  assert.deepEqual(sensors.map((node) => node.temperature_type), [3, 5]);
  for (const sensor of sensors) {
    assert.equal(sensor.start_disconnected, true);
    assert.equal(sensor.default_values, false);
  }
});
