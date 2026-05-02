export class CborDecodeError extends Error {}

export function decodeFirstCbor(buffer) {
  const offsets = [18, 16, 0, findCborOffset(buffer)].filter((value) => value !== null && value !== undefined);
  const seen = new Set();

  for (const offset of offsets) {
    if (seen.has(offset) || offset >= buffer.length) continue;
    seen.add(offset);
    try {
      return decodeCbor(buffer, offset).value;
    } catch {
      // Try the next likely boundary.
    }
  }
  return null;
}

export function findCborOffset(buffer) {
  const likely = new Set([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xbf, 0x81, 0x82, 0x83, 0x84, 0x9f]);
  for (let offset = 0; offset < buffer.length; offset += 1) {
    if (!likely.has(buffer[offset])) continue;
    try {
      const decoded = decodeCbor(buffer, offset);
      if (decoded.nextOffset >= buffer.length - 1) return offset;
    } catch {
      // Keep scanning.
    }
  }
  return null;
}

export function decodeCbor(buffer, offset = 0) {
  if (offset >= buffer.length) throw new CborDecodeError('offset past end');

  const initial = buffer[offset++];
  if (initial === 0xff) return { value: Symbol.for('break'), nextOffset: offset };

  const major = initial >> 5;
  const additional = initial & 0x1f;

  if (major === 0) {
    const [value, nextOffset] = readLength(buffer, offset, additional);
    return { value, nextOffset };
  }
  if (major === 1) {
    const [value, nextOffset] = readLength(buffer, offset, additional);
    return { value: -1 - value, nextOffset };
  }
  if (major === 2 || major === 3) {
    if (additional === 31) {
      const chunks = [];
      while (buffer[offset] !== 0xff) {
        const decoded = decodeCbor(buffer, offset);
        chunks.push(decoded.value);
        offset = decoded.nextOffset;
      }
      offset += 1;
      return {
        value: major === 2 ? Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) : chunks.join(''),
        nextOffset: offset
      };
    }
    const [length, bodyOffset] = readLength(buffer, offset, additional);
    const raw = buffer.subarray(bodyOffset, bodyOffset + length);
    return {
      value: major === 2 ? Buffer.from(raw) : raw.toString('utf8'),
      nextOffset: bodyOffset + length
    };
  }
  if (major === 4) {
    const values = [];
    if (additional === 31) {
      while (buffer[offset] !== 0xff) {
        const decoded = decodeCbor(buffer, offset);
        values.push(decoded.value);
        offset = decoded.nextOffset;
      }
      return { value: values, nextOffset: offset + 1 };
    }
    const [length, nextOffset] = readLength(buffer, offset, additional);
    offset = nextOffset;
    for (let i = 0; i < length; i += 1) {
      const decoded = decodeCbor(buffer, offset);
      values.push(decoded.value);
      offset = decoded.nextOffset;
    }
    return { value: values, nextOffset: offset };
  }
  if (major === 5) {
    const object = {};
    const pairs = [];
    const readPair = () => {
      const key = decodeCbor(buffer, offset);
      const val = decodeCbor(buffer, key.nextOffset);
      offset = val.nextOffset;
      pairs.push([key.value, val.value]);
      if (typeof key.value === 'string' || typeof key.value === 'number') object[key.value] = val.value;
    };

    if (additional === 31) {
      while (buffer[offset] !== 0xff) readPair();
      return { value: Object.keys(object).length === pairs.length ? object : pairs, nextOffset: offset + 1 };
    }
    const [length, nextOffset] = readLength(buffer, offset, additional);
    offset = nextOffset;
    for (let i = 0; i < length; i += 1) readPair();
    return { value: Object.keys(object).length === pairs.length ? object : pairs, nextOffset: offset };
  }
  if (major === 7) {
    if (additional === 20) return { value: false, nextOffset: offset };
    if (additional === 21) return { value: true, nextOffset: offset };
    if (additional === 22) return { value: null, nextOffset: offset };
    if (additional === 23) return { value: undefined, nextOffset: offset };
  }

  throw new CborDecodeError(`unsupported CBOR major=${major} additional=${additional}`);
}

function readLength(buffer, offset, additional) {
  if (additional < 24) return [additional, offset];
  if (additional === 24) return [buffer[offset], offset + 1];
  if (additional === 25) return [buffer.readUInt16BE(offset), offset + 2];
  if (additional === 26) return [buffer.readUInt32BE(offset), offset + 4];
  if (additional === 27) return [Number(buffer.readBigUInt64BE(offset)), offset + 8];
  throw new CborDecodeError(`unsupported additional info ${additional}`);
}
