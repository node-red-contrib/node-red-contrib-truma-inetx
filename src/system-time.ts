import { buildTrumaFrame } from './truma-frame.js';

export function utcOffsetMinutes(now: Date, timeZone?: string): number {
  if (!timeZone) return -now.getTimezoneOffset() || 0;
  const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value;
  if (offset === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (!match) throw new Error(`Could not determine the UTC offset for ${timeZone}.`);
  return (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function buildSystemTimeFrame(now = new Date(), timeZone?: string): Buffer {
  return buildTrumaFrame('00050005', '0300', '8400', {
    avail: 1,
    topics: [{ tn: 'SystemTime', parameters: [
      { type: 18, pn: 'Time', tn: 'SystemTime', v: Math.floor(now.getTime() / 1000) },
      { type: 1, pn: 'Lot', tn: 'SystemTime', v: utcOffsetMinutes(now, timeZone) }
    ] }]
  });
}
