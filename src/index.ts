import { setTimeout as delay } from 'node:timers/promises';

import { connectToTruma, disconnectQuietly, readSoftwareRevision, shutdownBluetooth, type ConnectOptions } from './ble.js';
import { buildGroupReadSequence, buildTopicReadSequence, DISCOVERY_SEQUENCE, TRUMA } from './constants.js';
import { TrumaProtocol, type ReadRequest, type TrumaProtocolOptions } from './protocol.js';
import { parseSettingsJson, type SettingsJson } from './settings.js';
import { decodeFirstCbor } from './truma-frame.js';

export { connectToTruma, disconnectQuietly, isTrumaPeripheral, readSoftwareRevision, shutdownBluetooth } from './ble.js';
export { buildGroupReadSequence, buildTopicReadSequence, DISCOVERY_SEQUENCE, TRUMA };
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
  topics?: string[];
  groups?: number[];
  sequence?: ReadRequest[];
}

export interface TrumaDiscoveryJson {
  topics: string[];
  deviceGroups: string[];
}

export async function readTrumaSettings({
  protocol,
  redact = true,
  logger = () => {},
  readRetries = 1,
  topics,
  groups,
  sequence,
  ...connectOptions
}: ReadTrumaSettingsOptions = {}): Promise<SettingsJson> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= readRetries; attempt += 1) {
    logger(`Starting Truma settings read (attempt ${attempt}/${readRetries}).`);
    const session = await connectToTruma({ ...connectOptions, logger });
    let trumaProtocol: TrumaProtocol | null = null;

    try {
      const softwareRevision = await readSoftwareRevision(session.characteristics);
      logger(`Software revision: ${softwareRevision || '<not available>'}.`);

      trumaProtocol = new TrumaProtocol(session.characteristics, {
        ...protocol,
        logger: protocol?.logger ?? logger
      });
      const readSequence = sequence ?? buildSelectedReadSequence({ topics, groups });
      if (topics?.length) logger(`Reading selected topic(s): ${topics.join(', ')}.`);
      if (groups?.length) logger(`Reading selected device group(s): ${groups.map(formatDeviceGroup).join(', ')}.`);
      const responses = await trumaProtocol.readAll(readSequence ? { sequence: readSequence } : undefined);
      return parseAndLogSettings(responses, { logger, redact, topics });
    } catch (error) {
      lastError = error;
      logger(`Read attempt ${attempt} failed: ${errorMessage(error)}.`);
      const partialResponses = trumaProtocol?.getResponseBuffers() ?? [];
      if (partialResponses.length > 0) {
        logger(`Returning partial JSON from ${partialResponses.length} collected response payload(s).`);
        return parseAndLogSettings(partialResponses, { logger, redact, topics });
      }
      if (attempt >= readRetries || !isRetryableReadError(error)) throw error;
      logger('Disconnecting and retrying the full BLE/protocol session.');
    } finally {
      trumaProtocol?.close();
      await disconnectQuietly(session.peripheral);
    }

    await delay(1500);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function discoverTrumaTopology({
  protocol,
  logger = () => {},
  readRetries = 1,
  ...connectOptions
}: Omit<ReadTrumaSettingsOptions, 'redact' | 'topics' | 'groups' | 'sequence'> = {}): Promise<TrumaDiscoveryJson> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= readRetries; attempt += 1) {
    logger(`Starting Truma topology discovery (attempt ${attempt}/${readRetries}).`);
    const session = await connectToTruma({ ...connectOptions, logger });
    let trumaProtocol: TrumaProtocol | null = null;

    try {
      const softwareRevision = await readSoftwareRevision(session.characteristics);
      logger(`Software revision: ${softwareRevision || '<not available>'}.`);

      trumaProtocol = new TrumaProtocol(session.characteristics, {
        ...protocol,
        logger: protocol?.logger ?? logger
      });
      const responses = await trumaProtocol.readAll({ sequence: DISCOVERY_SEQUENCE });
      return parseDiscovery(responses, logger);
    } catch (error) {
      lastError = error;
      logger(`Discovery attempt ${attempt} failed: ${errorMessage(error)}.`);
      const partialResponses = trumaProtocol?.getResponseBuffers() ?? [];
      if (partialResponses.length > 0) {
        logger(`Returning partial discovery from ${partialResponses.length} collected response payload(s).`);
        return parseDiscovery(partialResponses, logger);
      }
      if (attempt >= readRetries || !isRetryableReadError(error)) throw error;
      logger('Disconnecting and retrying the full BLE/protocol session.');
    } finally {
      trumaProtocol?.close();
      await disconnectQuietly(session.peripheral);
    }

    await delay(1500);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildSelectedReadSequence({ topics, groups }: { topics?: string[]; groups?: number[] }): ReadRequest[] | undefined {
  if (groups?.length) return buildGroupReadSequence(groups, topics ?? []);
  if (topics?.length) return buildTopicReadSequence(topics);
  return undefined;
}

function parseAndLogSettings(
  responses: Buffer[],
  { logger, redact, topics }: { logger: NonNullable<ConnectOptions['logger']>; redact: boolean; topics?: string[] }
): SettingsJson {
  logger(`Collected ${responses.length} response payload(s).`);
  logResponseDiagnostics(responses, logger);

  const settings = filterSettingsToTopics(parseSettingsJson(responses, { redact }), topics);
  const topicCount = Object.keys(settings.topics).length;
  logger(`Parsed ${topicCount} topic(s) and ${settings.topicLists.length} advertised topic-list item(s).`);
  if (topicCount === 0 && settings.topicLists.length === 0) {
    logger('No settings were decoded. This usually means the protocol only received handshake/empty responses, not the device-list or group payloads.');
  }
  return settings;
}

function parseDiscovery(responses: Buffer[], logger: NonNullable<ConnectOptions['logger']>): TrumaDiscoveryJson {
  logger(`Collected ${responses.length} discovery response payload(s).`);
  logResponseDiagnostics(responses, logger);
  const settings = parseSettingsJson(responses, { redact: false });
  const discovery = {
    topics: settings.topicLists,
    deviceGroups: collectDeviceGroups(responses)
  };
  logger(`Discovered ${discovery.topics.length} topic(s) and ${discovery.deviceGroups.length} device group(s).`);
  return discovery;
}

function collectDeviceGroups(responses: Buffer[]): string[] {
  const groups = new Set<number>();

  for (const response of responses) {
    const decoded = decodeFirstCbor(response);
    const body = Array.isArray(decoded) && decoded.length >= 2 ? decoded[1] : decoded;
    if (!isRecord(body) || !Array.isArray(body.Devices)) continue;

    for (const value of body.Devices) {
      if (Number.isInteger(value) && value >= 0 && value <= 0xffff) groups.add(value);
    }
  }

  return [...groups].sort((left, right) => left - right).map(formatDeviceGroup);
}

function filterSettingsToTopics(settings: SettingsJson, topics: string[] | undefined): SettingsJson {
  const requestedTopics = topics?.map((topic) => topic.trim()).filter(Boolean);
  if (!requestedTopics?.length) return settings;

  const allowed = new Set(requestedTopics);
  const filteredTopics: SettingsJson['topics'] = {};
  for (const [topicName, value] of Object.entries(settings.topics)) {
    if (allowed.has(topicName)) filteredTopics[topicName] = value;
  }

  return {
    topics: filteredTopics,
    topicLists: settings.topicLists.filter((topicName) => allowed.has(topicName)),
    diagnostics: {
      ...settings.diagnostics,
      topicGroups: Object.fromEntries(Object.entries(settings.diagnostics.topicGroups).filter(([topicName]) => allowed.has(topicName))),
      unreadTopics: settings.diagnostics.unreadTopics.filter((topicName) => allowed.has(topicName))
    }
  };
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

function formatDeviceGroup(deviceGroup: number): string {
  return `0x${deviceGroup.toString(16).padStart(4, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
