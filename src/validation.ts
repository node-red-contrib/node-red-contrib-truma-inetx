import { isDeepStrictEqual } from 'node:util';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Accept raw discovery metadata or the normalized settings-tree representation. */
export function validateParameterValue(value: unknown, metadata: unknown, label = 'Parameter'): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  if (value === undefined) throw new Error(`${label} requires a value.`);
  if (!record(metadata)) return;
  if ((metadata.available ?? metadata.avail) === 0 || (metadata.available ?? metadata.avail) === false) throw new Error(`${label} is unavailable.`);
  const minimum = metadata.min;
  const maximum = metadata.max;
  if (typeof minimum === 'number' || typeof maximum === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} requires a numeric value.`);
    if (typeof minimum === 'number' && value < minimum) throw new Error(`${label} must be at least ${minimum}.`);
    if (typeof maximum === 'number' && value > maximum) throw new Error(`${label} must be at most ${maximum}.`);
  }
  if (Array.isArray(metadata.enum) && metadata.enum.length) {
    const options = metadata.enum.filter((item) => !record(item) || ((item.available ?? item.a) !== 0 && (item.available ?? item.a) !== false));
    if (!options.some((item) => isDeepStrictEqual(record(item) ? (Object.hasOwn(item, 'value') ? item.value : item.v) : item, value))) {
      throw new Error(`${label} is not one of the available enum values.`);
    }
  }
}
