import { setTimeout as delay } from 'node:timers/promises';

import { connectToTruma, disconnectQuietly, readSoftwareRevision, shutdownBluetooth, type ConnectOptions } from './ble.js';
import { TRUMA } from './constants.js';
import { TrumaProtocol, type TrumaProtocolOptions } from './protocol.js';
import { parseSettingsJson, type SettingsJson } from './settings.js';
import { decodeFirstCbor } from './truma-frame.js';

export { connectToTruma, disconnectQuietly, isTrumaPeripheral, readSoftwareRevision, shutdownBluetooth } from './ble.js';
export { TRUMA };
export { TrumaProtocol };
export { buildTrumaFrame, decodeFirstCbor, decodeTrumaFrame, findCborOffset, parseTrumaHeader } from './truma-frame.js';
export { collectSettings, parseSettingsJson, settingsToJson } from './settings.js';
export type { ConnectOptions, TrumaSession } from './ble.js';
export type { TrumaCharacteristic, TrumaCharacteristics, TrumaProtocolOptions } from './protocol.js';
export type { CollectedSettings, JsonValue, SettingsJson, TrumaParameter, TrumaTopic } from './settings.js';
export type { TrumaFrame, TrumaFrameHeader, TrumaValue } from './truma-frame.js';

export interface ReadTrumaSettingsOptions extends ConnectOptions {
  protocol?: TrumaProtocolOptions;
  redact?: boolean;
  readRetries?: number;
}

export async function readTrumaSettings({
  protocol,
  redact = true,
  logger = () => {},
  readRetries = 1,
  ...connectOptions
}: ReadTrumaSettingsOptions = {}): Promise<SettingsJson> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= readRetries; attempt += 1) {
    logger(`Starting Truma settings read (attempt ${attempt}/${readRetries}).`);
    const session = await connectToTruma({ ...connectOptions, logger });

    try {
      const softwareRevision = await readSoftwareRevision(session.characteristics);
      logger(`Software revision: ${softwareRevision || '<not available>'}.`);

      const trumaProtocol = new TrumaProtocol(session.characteristics, {
        ...protocol,
        logger: protocol?.logger ?? logger
      });
      const responses = await trumaProtocol.readAll();
      logger(`Collected ${responses.length} response payload(s).`);
      logResponseDiagnostics(responses, logger);

      const settings = parseSettingsJson(responses, { redact });
      const topicCount = Object.keys(settings.topics).length;
      logger(`Parsed ${topicCount} topic(s) and ${settings.topicLists.length} advertised topic-list item(s).`);
      if (topicCount === 0 && settings.topicLists.length === 0) {
        logger('No settings were decoded. This usually means the protocol only received handshake/empty responses, not the device-list or group payloads.');
      }
      return settings;
    } catch (error) {
      lastError = error;
      logger(`Read attempt ${attempt} failed: ${errorMessage(error)}.`);
      if (attempt >= readRetries || !isRetryableReadError(error)) throw error;
      logger('Disconnecting and retrying the full BLE/protocol session.');
    } finally {
      await disconnectQuietly(session.peripheral);
    }

    await delay(1500);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function logResponseDiagnostics(responses: Buffer[], logger: NonNullable<ConnectOptions['logger']>): void {
  responses.forEach((response, index) => {
    const decoded = decodeFirstCbor(response);
    logger(`Response ${index + 1}: ${response.length} byte(s), hex=${response.toString('hex')}`);
    logger(`Response ${index + 1} decoded: ${summarizeDecoded(decoded)}`);
  });
}

function summarizeDecoded(value: unknown): string {
  if (value === null || value === undefined) return '<none>';
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return String(value);
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value;
}

function isRetryableReadError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('waiting for control notification') || message.includes('GATT') || message.includes('disconnect');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
