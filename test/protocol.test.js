import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGroupReadSequence, buildTopicReadSequence, buildTrumaFrame, decodeFirstCbor, DISCOVERY_SEQUENCE, TrumaProtocol } from '../dist/index.js';

test('learns assigned client address and rewrites later frame headers', () => {
  const protocol = new TrumaProtocol(fakeCharacteristics());
  const protocolResponse = Buffer.from('ffff00001c000100000000000000000002c1bf6270769f0501ff6461646472190503ff', 'hex');

  protocol.learnClientAddress(protocolResponse);

  const sourceClient = protocol.applyClientAddress(Buffer.from('000000050b00020000000000000000000100', 'hex'), 'source-client');
  assert.equal(sourceClient.subarray(0, 4).toString('hex'), '00000305');

  const clientLocal = protocol.applyClientAddress(Buffer.from('000500051900030000000000000000008400a16b4c6173744d65737361676501', 'hex'), 'client-local');
  assert.equal(clientLocal.subarray(0, 4).toString('hex'), '03050305');

  const groupRead = protocol.buildReadGroupFrame(0x0504);
  assert.equal(groupRead.subarray(0, 4).toString('hex'), '04050305');
});

test('flushes complete response frames without waiting for idle timing', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics());
  const first = buildTrumaFrame('00000505', '0300', '0400', { topics: [{ tn: 'System', parameters: [{ pn: 'Ready', v: true }] }] });
  const second = buildTrumaFrame('00000505', '0300', '0400', { topics: [{ tn: 'PowerSupply', parameters: [{ pn: 'Voltage', v: 12.4 }] }] });

  await protocol.handleDataNotification(first);
  await protocol.handleDataNotification(second);

  assert.equal(protocol.responseBuffers.length, 2);
  assert.equal(protocol.responseBuffers[0].toString('hex'), first.toString('hex'));
  assert.equal(protocol.responseBuffers[1].toString('hex'), second.toString('hex'));
});

test('appends tiny trailing fragments to the previous response', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics());
  const response = buildTrumaFrame('00000505', '0300', '0400', { topics: [{ tn: 'System', parameters: [{ pn: 'Ready', v: true }] }] });

  await protocol.handleDataNotification(response);
  await protocol.handleDataNotification(Buffer.from('ffff', 'hex'));

  assert.equal(protocol.responseBuffers.length, 1);
  assert.equal(protocol.responseBuffers[0].toString('hex'), `${response.toString('hex')}ffff`);
});

test('waits for announced response length before flushing split data', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics());
  const response = buildTrumaFrame('00000505', '0300', '0400', { topics: [{ tn: 'System', parameters: [{ pn: 'Ready', v: true }] }] });
  const splitAt = response.length - 3;

  protocol.handleControlNotification(Buffer.from([0x83, response.length & 0xff, response.length >> 8]));
  await protocol.handleDataNotification(response.subarray(0, splitAt));
  assert.equal(protocol.responseBuffers.length, 0);

  await protocol.handleDataNotification(response.subarray(splitAt));
  assert.equal(protocol.responseBuffers.length, 1);
  assert.equal(protocol.responseBuffers[0].toString('hex'), response.toString('hex'));
});

test('builds selected-topic read sequence', () => {
  const sequence = buildTopicReadSequence(['System', 'BluetoothDevice']);
  const selectedTopics = sequence[1];

  assert.equal(sequence.length, 6);
  assert.equal(selectedTopics.name, 'topics-System-BluetoothDevice');
  assert.equal(selectedTopics.addressMode, 'source-client');
  assert.deepEqual(decodeFirstCbor(selectedTopics.build()), { tn: ['System', 'BluetoothDevice'] });
  assert.equal(sequence[4].name, 'read-device-list');
  assert.equal(sequence[5].name, 'read-detected-device-groups');
  assert.deepEqual(sequence[5].topics, ['System', 'BluetoothDevice']);
});

test('builds explicit group read sequence without topic-to-group assumptions', () => {
  const sequence = buildGroupReadSequence([0x0501, 0x0201], ['EnergySrc']);
  const groupReads = sequence.slice(4);

  assert.deepEqual(sequence.map((request) => request.name), [
    'protocol-version',
    'topics-EnergySrc',
    'client-system-time',
    'client-last-message',
    'read-group-0201',
    'read-group-0501'
  ]);
  assert.equal(groupReads[0].build().subarray(0, 2).toString('hex'), '0102');
  assert.equal(groupReads[1].build().subarray(0, 2).toString('hex'), '0105');
});

test('discovery sequence stops before dynamic group parameter reads', () => {
  assert.equal(DISCOVERY_SEQUENCE.at(-1).name, 'read-device-list');
  assert.equal(DISCOVERY_SEQUENCE.some((request) => request.dynamic === 'device-groups'), false);
});

function fakeCharacteristics() {
  const characteristic = {
    uuid: 'fake',
    properties: [],
    read: async () => Buffer.alloc(0),
    write: async () => {},
    subscribe: async () => {},
    onData: () => {}
  };

  return {
    control: characteristic,
    write: characteristic,
    data: characteristic,
    extraNotify: null,
    softwareRevision: null
  };
}

test('write confirmation requires the requested value from the addressed group', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics(), { timings: { writeConfirmationTimeoutMs: 5 } });
  protocol.start = async () => {};
  const frame = (source, value, parameter = 'TgtTemp') => buildTrumaFrame(source, '0300', '0400', {
    topics: [{ tn: 'AirHeating', parameters: [{ pn: parameter, v: value }] }]
  });
  const request = { targetGroup: 0x0201, topicName: 'AirHeating', parameterName: 'TgtTemp', value: 220 };
  for (const response of [frame('03050201', 220), frame('03050102', 210), frame('03050102', 220, 'Temp')]) {
    protocol.sendFrame = async () => { protocol.responseBuffers.push(response); };
    await assert.rejects(protocol.writeParameter(request), { code: 'TRUMA_WRITE_UNCONFIRMED' });
  }
  protocol.sendFrame = async () => { protocol.responseBuffers.push(frame('03050102', 220)); };
  assert.equal((await protocol.writeParameter(request)).length, 1);
  protocol.close();
});

test('write confirmation rejects no response, earlier cached values and an outgoing frame echo', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics(), { timings: { writeConfirmationTimeoutMs: 5 } });
  protocol.start = async () => {};
  protocol.responseBuffers.push(buildTrumaFrame('03050102', '0300', '0400', { tn: 'AirHeating', pn: 'TgtTemp', v: 220 }));
  protocol.sendFrame = async () => {};
  const request = { targetGroup: 0x0201, topicName: 'AirHeating', parameterName: 'TgtTemp', value: 220 };
  await assert.rejects(protocol.writeParameter(request), { code: 'TRUMA_WRITE_UNCONFIRMED' });
  protocol.sendFrame = async (outgoing) => { protocol.responseBuffers.push(outgoing); };
  await assert.rejects(protocol.writeParameter(request), { code: 'TRUMA_WRITE_UNCONFIRMED' });
  protocol.close();
});

test('transport failure after payload submission is unconfirmed; failure before submission stays a connection error', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics());
  protocol.start = async () => {};
  const request = { targetGroup: 0x0201, topicName: 'AirHeating', parameterName: 'TgtTemp', value: 220 };
  const failure = new Error('GATT disconnected');
  protocol.sendFrame = async () => { throw failure; };
  await assert.rejects(protocol.writeParameter(request), (error) => error === failure);
  protocol.sendFrame = async (_payload, _request, submitted) => { submitted(); throw failure; };
  await assert.rejects(protocol.writeParameter(request), (error) => error.code === 'TRUMA_WRITE_UNCONFIRMED' && error.cause === failure);
  protocol.close();
});

test('a decodable CBOR value in a frame that is shorter than its declared length is not a confirmation', async () => {
  const protocol = new TrumaProtocol(fakeCharacteristics(), { timings: { writeConfirmationTimeoutMs: 5 } });
  protocol.start = async () => {};
  const frame = buildTrumaFrame('03050102', '0300', '0400', { tn: 'AirHeating', pn: 'TgtTemp', v: 220 });
  frame.writeUInt16LE(frame.readUInt16LE(4) + 10, 4);
  protocol.sendFrame = async () => { protocol.responseBuffers.push(frame); };
  await assert.rejects(protocol.writeParameter({ targetGroup: 0x0201, topicName: 'AirHeating', parameterName: 'TgtTemp', value: 220 }), { code: 'TRUMA_WRITE_UNCONFIRMED' });
  protocol.close();
});
