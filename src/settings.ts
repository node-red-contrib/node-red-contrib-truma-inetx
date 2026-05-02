import { decodeFirstCbor, parseTrumaHeader } from './truma-frame.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TrumaParameter {
  tn?: string;
  pn?: string;
  type?: number;
  avail?: unknown;
  perm?: unknown;
  v?: unknown;
  min?: unknown;
  max?: unknown;
  [key: string]: unknown;
}

export interface TrumaTopic {
  tn?: string | string[];
  parameters?: TrumaParameter[];
  [key: string]: unknown;
}

export interface CollectedSettings {
  settings: Map<string, Map<string, TrumaParameter>>;
  topicLists: string[];
  deviceGroups: number[];
  topicGroups: Map<string, number[]>;
}

export interface SettingsJson {
  topics: Record<string, Record<string, JsonValue>>;
  topicLists: string[];
  diagnostics: {
    topicGroups: Record<string, string[]>;
    unreadTopics: string[];
    deviceGroups: string[];
    unreadDeviceGroups: string[];
  };
}

const SENSITIVE_PARAMETERS = new Set(['CertThumb', 'Muid', 'SerialNr', 'UniqueID', 'UserName', 'Uuid']);

export function collectSettings(responseBuffers: Buffer[]): CollectedSettings {
  const settings = new Map<string, Map<string, TrumaParameter>>();
  const topicLists: string[] = [];
  const deviceGroups = new Set<number>();
  const topicGroups = new Map<string, Set<number>>();

  for (const buffer of responseBuffers) {
    const decoded = decodeFirstCbor(buffer);
    if (!decoded) continue;

    const candidate = responseBody(decoded);
    if (isRecord(candidate) && Array.isArray(candidate.tn)) topicLists.push(...candidate.tn.map(String));
    if (isRecord(candidate) && Array.isArray(candidate.Devices)) {
      for (const value of candidate.Devices) {
        if (Number.isInteger(value) && value >= 0 && value <= 0xffff) deviceGroups.add(value);
      }
    }

    const topics = normalizeTopics(decoded);
    const header = topics.length ? parseTrumaHeader(buffer) : null;
    const sourceGroup = header && header.source !== 0 && header.source !== 0xffff ? header.source : null;

    for (const topic of topics) {
      const topicName = String(topic.tn ?? '<unknown>');
      if (sourceGroup !== null) {
        if (!topicGroups.has(topicName)) topicGroups.set(topicName, new Set());
        topicGroups.get(topicName)?.add(sourceGroup);
      }
      if (!settings.has(topicName)) settings.set(topicName, new Map());
      const bucket = settings.get(topicName);
      if (!bucket) continue;

      for (const parameter of Array.isArray(topic.parameters) ? topic.parameters : []) {
        if (!isRecord(parameter)) continue;
        const typedParameter = parameter as TrumaParameter;
        const parameterName = String(typedParameter.pn ?? '<unknown>');
        bucket.set(parameterName, { ...(bucket.get(parameterName) || {}), ...typedParameter });
      }
    }
  }

  return {
    settings,
    topicLists: [...new Set(topicLists)],
    deviceGroups: [...deviceGroups].sort(sortNumber),
    topicGroups: sortTopicGroups(topicGroups)
  };
}

export function settingsToJson({ settings, topicLists, deviceGroups, topicGroups }: CollectedSettings, { redact = true } = {}): SettingsJson {
  const topics: SettingsJson['topics'] = {};

  for (const [topicName, params] of settings.entries()) {
    topics[topicName] = {};
    for (const [parameterName, parameter] of params.entries()) {
      topics[topicName][parameterName] = sanitizeJsonObject(
        { ...parameter, v: maybeRedact(parameter.v, parameterName, redact) },
        redact
      );
    }
  }

  const topicGroupsJson = topicGroupsToJson(topicGroups);
  const mappedTopicSet = new Set(Object.keys(topicGroupsJson));
  const unreadTopics = topicLists.filter((topicName) => !mappedTopicSet.has(topicName));
  const readGroupSet = new Set([...topicGroups.values()].flat());
  const unreadDeviceGroups = deviceGroups.filter((deviceGroup) => !readGroupSet.has(deviceGroup));

  return {
    topics,
    topicLists,
    diagnostics: {
      topicGroups: topicGroupsJson,
      unreadTopics,
      deviceGroups: deviceGroups.map(formatDeviceGroup),
      unreadDeviceGroups: unreadDeviceGroups.map(formatDeviceGroup)
    }
  };
}

export function parseSettingsJson(responseBuffers: Buffer[], options: { redact?: boolean } = {}): SettingsJson {
  return settingsToJson(collectSettings(responseBuffers), options);
}

function normalizeTopics(value: unknown): TrumaTopic[] {
  const candidate = responseBody(value);

  if (isRecord(candidate) && Array.isArray(candidate.topics)) {
    return candidate.topics.filter(isRecord) as TrumaTopic[];
  }

  if (isRecord(candidate) && candidate.tn && candidate.pn) {
    return [{ tn: String(candidate.tn), parameters: [candidate as TrumaParameter] }];
  }

  return [];
}

function responseBody(value: unknown): unknown {
  if (Array.isArray(value) && value.length >= 2 && isRecord(value[1])) return value[1];
  return value;
}

function maybeRedact(value: unknown, parameterName: string, redact: boolean): unknown {
  return redact && SENSITIVE_PARAMETERS.has(parameterName) ? '<redacted>' : value;
}

function sanitizeJsonObject(value: unknown, redact: boolean): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonObject(item, redact));
  if (!isRecord(value)) return String(value);

  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sanitizeJsonObject(key === 'v' && typeof value.pn === 'string' ? maybeRedact(item, value.pn, redact) : item, redact);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sortNumber(left: number, right: number): number {
  return left - right;
}

function sortTopicGroups(topicGroups: Map<string, Set<number>>): Map<string, number[]> {
  return new Map(
    [...topicGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([topicName, groups]) => [topicName, [...groups].sort(sortNumber)])
  );
}

function topicGroupsToJson(topicGroups: Map<string, number[]>): Record<string, string[]> {
  return Object.fromEntries([...topicGroups.entries()].map(([topicName, groups]) => [topicName, groups.map(formatDeviceGroup)]));
}

function formatDeviceGroup(deviceGroup: number): string {
  return `0x${deviceGroup.toString(16).padStart(4, '0')}`;
}
