import { decodeFirstCbor } from './truma-frame.js';

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
}

export interface SettingsJson {
  topics: Record<string, Record<string, JsonValue>>;
  topicLists: string[];
}

const SENSITIVE_PARAMETERS = new Set(['CertThumb', 'Muid', 'SerialNr', 'UniqueID', 'UserName', 'Uuid']);

export function collectSettings(responseBuffers: Buffer[]): CollectedSettings {
  const settings = new Map<string, Map<string, TrumaParameter>>();
  const topicLists: string[] = [];

  for (const buffer of responseBuffers) {
    const decoded = decodeFirstCbor(buffer);
    if (!decoded) continue;

    const candidate = responseBody(decoded);
    if (isRecord(candidate) && Array.isArray(candidate.tn)) topicLists.push(...candidate.tn.map(String));

    for (const topic of normalizeTopics(decoded)) {
      const topicName = String(topic.tn ?? '<unknown>');
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

  return { settings, topicLists: [...new Set(topicLists)] };
}

export function settingsToJson({ settings, topicLists }: CollectedSettings, { redact = true } = {}): SettingsJson {
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

  return { topics, topicLists };
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
