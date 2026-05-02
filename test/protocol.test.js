import assert from 'node:assert/strict';
import test from 'node:test';

import { TrumaProtocol } from '../dist/index.js';

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
