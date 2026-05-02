import { decode, Encoder } from 'cbor-x';

export type TrumaValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | TrumaValue[]
  | { [key: string]: TrumaValue };

export interface TrumaFrameHeader {
  target: number;
  source: number;
  bodyLength: number;
  operation: number;
  sequence: bigint;
  flags: number;
}

export interface TrumaFrame {
  header: TrumaFrameHeader | null;
  value: unknown;
  cborOffset: number;
}

const LIKELY_CBOR_START_BYTES = new Set([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xbf, 0x81, 0x82, 0x83, 0x84, 0x9f]);
const trumaCborEncoder = new Encoder({
  useRecords: false,
  variableMapSize: true
});

export function buildTrumaFrame(addressHex: string, opHex: string, flagsHex: string, value: TrumaValue): Buffer {
  const cbor = Buffer.from(trumaCborEncoder.encode(value));
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

export function decodeTrumaFrame(buffer: Buffer): TrumaFrame | null {
  const decoded = decodeFirstCbor(buffer);
  if (decoded === null) return null;

  const cborOffset = findCborOffset(buffer);
  return {
    header: cborOffset !== null && cborOffset >= 18 ? parseTrumaHeader(buffer) : null,
    value: decoded,
    cborOffset: cborOffset ?? 0
  };
}

export function decodeFirstCbor(buffer: Buffer): unknown | null {
  const offsets = [18, 16, 0, findCborOffset(buffer)].filter((value): value is number => value !== null);
  const seen = new Set<number>();

  for (const offset of offsets) {
    if (seen.has(offset) || offset >= buffer.length) continue;
    seen.add(offset);
    const decoded = decodeCborAt(buffer, offset);
    if (decoded !== null) return decoded;
  }

  return null;
}

export function findCborOffset(buffer: Buffer): number | null {
  for (let offset = 0; offset < buffer.length; offset += 1) {
    if (!LIKELY_CBOR_START_BYTES.has(buffer[offset])) continue;
    if (decodeCborAt(buffer, offset) !== null) return offset;
  }

  return null;
}

export function parseTrumaHeader(buffer: Buffer): TrumaFrameHeader | null {
  if (buffer.length < 18) return null;

  return {
    target: buffer.readUInt16LE(0),
    source: buffer.readUInt16LE(2),
    bodyLength: buffer.readUInt16LE(4),
    operation: buffer.readUInt16LE(6),
    sequence: buffer.readBigUInt64LE(8),
    flags: buffer.readUInt16LE(16)
  };
}

function decodeCborAt(buffer: Buffer, offset: number): unknown | null {
  try {
    return decode(buffer.subarray(offset));
  } catch {
    return null;
  }
}
