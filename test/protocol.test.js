import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTopicReadSequence, buildTrumaFrame, decodeFirstCbor, TrumaProtocol } from '../dist/index.js';

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

test('builds selected-topic read sequence', () => {
  const sequence = buildTopicReadSequence(['System', 'BluetoothDevice']);
  const selectedTopics = sequence.at(-1);

  assert.equal(sequence.length, 4);
  assert.equal(selectedTopics.name, 'topics-System-BluetoothDevice');
  assert.equal(selectedTopics.addressMode, 'source-client');
  assert.deepEqual(decodeFirstCbor(selectedTopics.build()), { tn: ['System', 'BluetoothDevice'] });
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
