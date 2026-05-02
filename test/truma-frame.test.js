import assert from 'node:assert/strict';
import test from 'node:test';

import { buildParameterWriteFrame, buildTrumaFrame, decodeFirstCbor, parseTrumaHeader, TRUMA } from '../dist/index.js';
import { READ_SEQUENCE } from '../dist/constants.js';

test('decodes CBOR from Truma response frame offsets', () => {
  const response = Buffer.from('ffff00001c000100000000000000000002c1bf6270769f0501ff6461646472190503ff', 'hex');

  assert.deepEqual(decodeFirstCbor(response), { pv: [5, 1], addr: 1283 });
});

test('builds Truma frames with a valid binary header', () => {
  const frame = buildTrumaFrame('00050005', '0300', '8400', {
    LastMessage: 1
  });

  assert.equal(frame.subarray(0, 4).toString('hex'), '00050005');
  assert.deepEqual(parseTrumaHeader(frame), {
    target: 0x0500,
    source: 0x0500,
    bodyLength: 25,
    operation: 3,
    sequence: 0n,
    flags: 0x0084
  });
  assert.deepEqual(decodeFirstCbor(frame), { LastMessage: 1 });
});

test('builds compact CBOR frames compatible with captured Truma packets', () => {
  const request = READ_SEQUENCE.find((item) => item.name === 'client-system-time');
  const frame = request.build();

  assert.equal(frame.length, 130);
  assert.equal(parseTrumaHeader(frame).bodyLength, 123);
  assert.equal(frame.includes(Buffer.from('b900', 'hex')), false);
  assert.equal(frame[18], 0xa2);
  assert.equal(TRUMA.advertisedNamePrefix, 'Truma iNetX');
});

test('builds parameter write frames from captured switch traffic', () => {
  const frame = buildParameterWriteFrame(0x0405, 'Switches', 'ExternalLights', 1);
  const header = parseTrumaHeader(frame);

  assert.equal(frame.subarray(0, 4).toString('hex'), '05040000');
  assert.equal(header.target, 0x0405);
  assert.equal(header.source, 0x0000);
  assert.equal(header.operation, 3);
  assert.equal(header.flags, 0x0001);
  assert.deepEqual(decodeFirstCbor(frame), {
    tn: 'Switches',
    pn: 'ExternalLights',
    v: 1
  });
});
