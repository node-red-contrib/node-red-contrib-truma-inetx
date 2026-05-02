export const TRUMA = {
  advertisedNamePrefix: 'Truma iNetX',
  advertisedServiceUuid: 'fc310001f3b211e88eb2f2801f1b9fd1',
  serviceUuid: 'fc314000f3b211e88eb2f2801f1b9fd1',
  controlUuid: 'fc314001f3b211e88eb2f2801f1b9fd1',
  writeUuid: 'fc314002f3b211e88eb2f2801f1b9fd1',
  dataUuid: 'fc314003f3b211e88eb2f2801f1b9fd1',
  extraNotifyUuid: 'fc314004f3b211e88eb2f2801f1b9fd1',
  softwareRevisionUuid: '2a28'
};

export const READ_SEQUENCE = [
  {
    name: 'protocol-version',
    hex: '0000ffff12000100000000000000000001c1a1627076820501'
  },
  {
    name: 'topics-climate-and-tanks',
    addressMode: 'source-client',
    hex: '000000058200030000000000000000000200a162746e8a6e41697243697263756c6174696f6e6a416972436f6f6c696e676a41697248656174696e67704465766963654d616e6167656d656e7469456e657267795372636a4572726f7252657365746a467265736857617465726647617342746c6a476173436f6e74726f6c69477265795761746572'
  },
  {
    name: 'client-system-time',
    addressMode: 'client-local',
    build: () => buildTrumaFrame('00050005', '0300', '8400', {
      avail: 1,
      topics: [
        {
          tn: 'SystemTime',
          parameters: [
            { type: 18, pn: 'Time', tn: 'SystemTime', v: Math.floor(Date.now() / 1000) },
            { type: 1, pn: 'Lot', tn: 'SystemTime', v: 720 }
          ]
        }
      ]
    })
  },
  {
    name: 'client-last-message',
    addressMode: 'client-local',
    hex: '000500051900030000000000000000008400a16b4c6173744d65737361676501'
  },
  {
    name: 'topics-core',
    addressMode: 'source-client',
    hex: '000000057400030000000000000000000200a162746e8a684964656e74696679654c31426174654c32426174694c696e65506f7765726e4d6f62696c654964656e746974796b506f776572537570706c796b526f6f6d436c696d6174656853776974636865736b54656d7065726174757265685472616e73666572'
  },
  {
    name: 'topics-panel-and-ble',
    addressMode: 'source-client',
    hex: '000000058200030000000000000000000200a162746e8a64564261746c576174657248656174696e676c416d6269656e744c696768746550616e656c6c426174746572794d6e676d7467496e7374616c6c67436f6e6e6563746b54696d6572436f6e66696773426c654465766963654d616e6167656d656e746f426c7565746f6f7468446576696365'
  },
  {
    name: 'topics-system',
    addressMode: 'source-client',
    hex: '000000052b00030000000000000000000200a162746e836653797374656d695265736f757263657369506f7765724d676d74'
  },
  {
    name: 'read-device-list',
    addressMode: 'source-client',
    hex: '000000050b00020000000000000000000100'
  },
  {
    name: 'read-detected-device-groups',
    dynamic: 'device-groups'
  }
];

function buildTrumaFrame(addressHex, opHex, flagsHex, cborValue) {
  const cbor = encodeCbor(cborValue);
  const bodyLength = 1 + 8 + 2 + cbor.length;
  return Buffer.concat([
    Buffer.from(addressHex, 'hex'),
    Buffer.from([bodyLength & 0xff, (bodyLength >> 8) & 0xff]),
    Buffer.from(opHex, 'hex'),
    Buffer.alloc(8),
    Buffer.from(flagsHex, 'hex'),
    cbor
  ]);
}

function encodeCbor(value) {
  if (typeof value === 'number') return encodeUnsigned(value);
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) return Buffer.concat([encodeTypeAndLength(4, value.length), ...value.map(encodeCbor)]);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Buffer.concat([
      encodeTypeAndLength(5, entries.length),
      ...entries.flatMap(([key, item]) => [encodeString(key), encodeCbor(item)])
    ]);
  }
  throw new Error(`Unsupported CBOR value: ${value}`);
}

function encodeUnsigned(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Unsupported CBOR number: ${value}`);
  return encodeTypeAndLength(0, value);
}

function encodeString(value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeTypeAndLength(3, data.length), data]);
}

function encodeTypeAndLength(major, length) {
  const prefix = major << 5;
  if (length < 24) return Buffer.from([prefix | length]);
  if (length <= 0xff) return Buffer.from([prefix | 24, length]);
  if (length <= 0xffff) return Buffer.from([prefix | 25, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.from([prefix | 26, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}
