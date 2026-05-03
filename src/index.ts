import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

import { connectToTruma, disconnectQuietly, readSoftwareRevision, shutdownBluetooth, type ConnectOptions } from './ble.js';
import { buildGroupReadSequence, buildTopicReadSequence, READ_SEQUENCE, TRUMA } from './constants.js';
import { TrumaProtocol, type ReadRequest, type TrumaProtocolOptions } from './protocol.js';
import { parseSettingsJson, type SettingsJson } from './settings.js';
import { decodeFirstCbor, type TrumaValue } from './truma-frame.js';

export { connectToTruma, disconnectQuietly, isTrumaPeripheral, readSoftwareRevision, shutdownBluetooth } from './ble.js';
export { buildGroupReadSequence, buildTopicReadSequence, DISCOVERY_SEQUENCE, READ_SEQUENCE, TRUMA } from './constants.js';
export { TrumaProtocol };
export { buildParameterWriteFrame, buildTrumaFrame, decodeFirstCbor, decodeTrumaFrame, findCborOffset, parseTrumaHeader } from './truma-frame.js';
export { collectSettings, parseSettingsJson, settingsToJson } from './settings.js';
export type { ConnectOptions, TrumaSession } from './ble.js';
export type { TrumaCharacteristic, TrumaCharacteristics, TrumaProtocolOptions } from './protocol.js';
export type { CollectedSettings, JsonValue, SettingsJson, SettingsTopicJson, TrumaParameter, TrumaTopic } from './settings.js';
export type { TrumaFrame, TrumaFrameHeader, TrumaValue } from './truma-frame.js';

export interface ReadTrumaSettingsOptions extends ConnectOptions {
  protocol?: TrumaProtocolOptions;
  redact?: boolean;
  readRetries?: number;
  topics?: string[];
  groups?: number[];
  sequence?: ReadRequest[];
}

export interface SetTrumaParameterOptions extends ConnectOptions {
  protocol?: TrumaProtocolOptions;
  redact?: boolean;
  readRetries?: number;
  targetGroup: number;
  topic: string;
  parameter: string;
  value: TrumaValue;
}

export interface PairTrumaOptions extends ConnectOptions {
  protocol?: TrumaProtocolOptions;
  holdMs?: number;
  linuxPairingMethod?: LinuxPairingMethod;
  linuxAgent?: boolean;
  linuxAgentCapability?: LinuxAgentCapability;
  linuxLegacyPairing?: boolean;
  linuxLegacyPowerCycle?: boolean;
  linuxDisablePrivacy?: boolean;
}

export interface PrepareVictronBluezOptions {
  logger?: ConnectOptions['logger'];
  powerCycle?: boolean;
  disablePrivacy?: boolean;
}

export interface PairTrumaResult {
  status: 'pairing-triggered';
  holdMs: number;
  linuxLegacyPairing?: boolean;
  linuxAgent?: {
    capability: LinuxAgentCapability;
  };
  bluez?: BluezPairResult;
}

export interface BluezPairResult {
  path: string;
  address: string | null;
  name: string | null;
  paired: boolean | null;
  trusted: boolean | null;
}

export interface PrepareVictronBluezResult {
  status: 'victron-bluez-prepared';
  persistent: true;
  settings: string;
}

export type LinuxAgentCapability = 'DisplayOnly' | 'DisplayYesNo' | 'KeyboardOnly' | 'NoInputNoOutput' | 'KeyboardDisplay';
export type LinuxPairingMethod = 'noble-trigger' | 'bluez';

const requireOptional = createRequire(import.meta.url);

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
  redact = true,
  logger = () => {},
  readRetries = 1,
  ...connectOptions
}: Omit<ReadTrumaSettingsOptions, 'topics' | 'groups' | 'sequence'> = {}): Promise<SettingsJson> {
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
      const responses = await trumaProtocol.readAll({ sequence: READ_SEQUENCE });
      return parseAndLogSettings(responses, { logger, redact });
    } catch (error) {
      lastError = error;
      logger(`Discovery attempt ${attempt} failed: ${errorMessage(error)}.`);
      const partialResponses = trumaProtocol?.getResponseBuffers() ?? [];
      if (partialResponses.length > 0) {
        logger(`Returning partial discovery from ${partialResponses.length} collected response payload(s).`);
        return parseAndLogSettings(partialResponses, { logger, redact });
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

export async function setTrumaParameter({
  protocol,
  redact = true,
  logger = () => {},
  readRetries = 1,
  targetGroup,
  topic,
  parameter,
  value,
  ...connectOptions
}: SetTrumaParameterOptions): Promise<SettingsJson> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= readRetries; attempt += 1) {
    logger(`Starting Truma parameter write (attempt ${attempt}/${readRetries}).`);
    const session = await connectToTruma({ ...connectOptions, logger });
    let trumaProtocol: TrumaProtocol | null = null;

    try {
      const softwareRevision = await readSoftwareRevision(session.characteristics);
      logger(`Software revision: ${softwareRevision || '<not available>'}.`);

      trumaProtocol = new TrumaProtocol(session.characteristics, {
        ...protocol,
        logger: protocol?.logger ?? logger
      });

      logger('Initializing protocol and learning assigned client address before writing.');
      await trumaProtocol.initializeClientAddress();
      logger(`Writing ${topic}.${parameter}=${summarizeDecoded(value)} to ${formatDeviceGroup(targetGroup)}.`);
      const responses = await trumaProtocol.writeParameter({
        targetGroup,
        topicName: topic,
        parameterName: parameter,
        value
      });
      return parseAndLogSettings(responses, { logger, redact, topics: [topic] });
    } catch (error) {
      lastError = error;
      logger(`Write attempt ${attempt} failed: ${errorMessage(error)}.`);
      const partialResponses = trumaProtocol?.getResponseBuffers() ?? [];
      if (partialResponses.length > 0) {
        logger(`Returning partial JSON from ${partialResponses.length} collected response payload(s).`);
        return parseAndLogSettings(partialResponses, { logger, redact, topics: [topic] });
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

export async function pairTruma({
  protocol,
  logger = () => {},
  holdMs = 20000,
  linuxPairingMethod = 'noble-trigger',
  linuxAgent = process.platform === 'linux',
  linuxAgentCapability = 'NoInputNoOutput',
  linuxLegacyPairing = false,
  linuxLegacyPowerCycle = false,
  linuxDisablePrivacy = false,
  ...connectOptions
}: PairTrumaOptions = {}): Promise<PairTrumaResult> {
  logger('Starting Truma pairing trigger.');
  if (linuxPairingMethod === 'bluez') {
    return pairTrumaWithBluez({
      logger,
      holdMs,
      linuxAgent,
      linuxAgentCapability,
      linuxLegacyPairing,
      linuxLegacyPowerCycle,
      linuxDisablePrivacy,
      namePrefix: connectOptions.namePrefix,
      matchServiceUuid: connectOptions.matchServiceUuid,
      timeoutMs: connectOptions.timeoutMs
    });
  }

  const legacyPairing = await startLinuxPairingControllerTweaks({
    enabled: linuxLegacyPairing || linuxDisablePrivacy,
    legacyPairing: linuxLegacyPairing,
    disablePrivacy: linuxDisablePrivacy,
    powerCycle: linuxLegacyPowerCycle,
    logger
  });
  const agent = await startLinuxPairingAgent({ enabled: linuxAgent, capability: linuxAgentCapability, logger });
  const session = await connectToTruma({ ...connectOptions, logger });
  let trumaProtocol: TrumaProtocol | null = null;

  try {
    trumaProtocol = new TrumaProtocol(session.characteristics, {
      ...protocol,
      logger: protocol?.logger ?? logger
    });
    const softwareRevision = await readSoftwareRevision(session.characteristics);
    logger(`Software revision: ${softwareRevision || '<not available>'}.`);
    await trumaProtocol.triggerPairingOnly();
    logger(`Pairing trigger sent. Holding connection for ${holdMs}ms so the operating system can finish pairing.`);
    await delay(holdMs);
    return {
      status: 'pairing-triggered',
      holdMs,
      ...(agent.started ? { linuxAgent: { capability: linuxAgentCapability } } : {}),
      ...(legacyPairing.started ? { linuxLegacyPairing: true } : {})
    };
  } finally {
    trumaProtocol?.close();
    await disconnectQuietly(session.peripheral);
    await agent.stop();
    await legacyPairing.stop();
  }
}

export async function prepareVictronBluez({
  logger = () => {},
  powerCycle = true,
  disablePrivacy = false
}: PrepareVictronBluezOptions = {}): Promise<PrepareVictronBluezResult> {
  logger('Preparing persistent BlueZ settings for Victron/Venus OS.');
  await startLinuxPairingControllerTweaks({
    enabled: true,
    legacyPairing: true,
    disablePrivacy,
    powerCycle,
    restore: false,
    logger
  });
  const info = await runBtmgmt(['info'], 3000).catch((error: unknown) => {
    throw new Error(`Could not read BlueZ controller settings after Victron preparation: ${errorMessage(error)}`);
  });
  const settings = summarizeBtmgmtSettings(info.stdout);
  logger(`Persistent Victron/Venus BlueZ settings applied: ${settings}.`);
  return {
    status: 'victron-bluez-prepared',
    persistent: true,
    settings
  };
}

async function pairTrumaWithBluez({
  logger,
  holdMs,
  linuxAgent,
  linuxAgentCapability,
  linuxLegacyPairing,
  linuxLegacyPowerCycle,
  linuxDisablePrivacy,
  namePrefix = TRUMA.advertisedNamePrefix,
  matchServiceUuid = TRUMA.advertisedServiceUuid,
  timeoutMs = 30000
}: {
  logger: NonNullable<ConnectOptions['logger']>;
  holdMs: number;
  linuxAgent: boolean;
  linuxAgentCapability: LinuxAgentCapability;
  linuxLegacyPairing: boolean;
  linuxLegacyPowerCycle: boolean;
  linuxDisablePrivacy: boolean;
  namePrefix?: string;
  matchServiceUuid?: string | null;
  timeoutMs?: number;
}): Promise<PairTrumaResult> {
  if (process.platform !== 'linux') throw new Error('BlueZ D-Bus pairing is only available on Linux.');

  const controllerTweaks = await startLinuxPairingControllerTweaks({
    enabled: linuxLegacyPairing || linuxDisablePrivacy,
    legacyPairing: linuxLegacyPairing,
    disablePrivacy: linuxDisablePrivacy,
    powerCycle: linuxLegacyPowerCycle,
    logger
  });
  try {
    const bluez = await bluezPairTruma({ logger, namePrefix, serviceUuid: matchServiceUuid, timeoutMs, agentCapability: linuxAgentCapability });
    logger(`BlueZ pair completed. Holding for ${holdMs}ms so bluetoothd can flush bond state.`);
    await delay(holdMs);
    return {
      status: 'pairing-triggered',
      holdMs,
      ...(linuxAgent ? { linuxAgent: { capability: linuxAgentCapability } } : {}),
      ...(controllerTweaks.started ? { linuxLegacyPairing: true } : {}),
      bluez
    };
  } finally {
    await controllerTweaks.stop();
  }
}

async function bluezPairTruma({
  logger,
  namePrefix,
  serviceUuid,
  timeoutMs,
  agentCapability
}: {
  logger: NonNullable<ConnectOptions['logger']>;
  namePrefix: string;
  serviceUuid: string | null;
  timeoutMs: number;
  agentCapability: LinuxAgentCapability;
}): Promise<BluezPairResult> {
  const { systemBus, Variant, Interface } = loadDbusNext();
  const bus = systemBus();
  const normalizedServiceUuid = serviceUuid ? normalizeCompactUuid(serviceUuid) : undefined;
  const canonicalServiceUuid = normalizedServiceUuid ? formatCanonicalUuid(normalizedServiceUuid) : undefined;
  let agent: { path: string; iface: BluezServiceInterface; stop: () => Promise<void> } | null = null;

  try {
    const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
    const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
    const objects = await objectManager.GetManagedObjects();
    const adapterPath = findBluezAdapterPath(objects);
    if (!adapterPath) throw new Error('Could not find a BlueZ adapter via org.bluez ObjectManager.');

    logger(`Using BlueZ adapter ${adapterPath}.`);
    agent = await registerBluezPairingAgent({ bus, Interface, capability: agentCapability, logger });
    const adapterObject = await bus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObject.getInterface('org.bluez.Adapter1') as BluezAdapter;

    await setBluezDiscoveryFilter(adapter, Variant, canonicalServiceUuid, logger);
    await adapter.StartDiscovery();
    logger(`BlueZ discovery started. Waiting up to ${timeoutMs}ms for ${namePrefix}.`);

    try {
      const device = await waitForBluezDevice({ objectManager, initialObjects: objects, namePrefix, serviceUuid: canonicalServiceUuid, timeoutMs, logger });
      logger(`BlueZ discovered Truma device ${device.address || '<unknown address>'} at ${device.path}.`);

      const deviceObject = await bus.getProxyObject('org.bluez', device.path);
      const properties = deviceObject.getInterface('org.freedesktop.DBus.Properties') as BluezProperties;
      const bluezDevice = deviceObject.getInterface('org.bluez.Device1') as BluezDevice;

      if (!(await getBluezBoolean(properties, 'org.bluez.Device1', 'Paired'))) {
        logger('Calling BlueZ Device1.Pair().');
        await pairBluezDevice({ device: bluezDevice, properties, logger, timeoutMs: Math.max(timeoutMs, 45000) });
      } else {
        logger('BlueZ device is already paired.');
      }

      logger('Marking BlueZ device as trusted.');
      await properties.Set('org.bluez.Device1', 'Trusted', new Variant('b', true));
      const paired = await getBluezBoolean(properties, 'org.bluez.Device1', 'Paired');
      const trusted = await getBluezBoolean(properties, 'org.bluez.Device1', 'Trusted');
      const address = await getBluezString(properties, 'org.bluez.Device1', 'Address');
      const name = await getBluezString(properties, 'org.bluez.Device1', 'Name');
      return { path: device.path, address, name, paired, trusted };
    } finally {
      await adapter.StopDiscovery().catch((error: unknown) => logger(`Warning: could not stop BlueZ discovery: ${errorMessage(error)}`));
    }
  } finally {
    if (agent) await agent.stop();
    bus.disconnect();
  }
}

async function pairBluezDevice({
  device,
  properties,
  logger,
  timeoutMs
}: {
  device: BluezDevice;
  properties: BluezProperties;
  logger: NonNullable<ConnectOptions['logger']>;
  timeoutMs: number;
}): Promise<void> {
  const pairPromise = device.Pair();
  pairPromise.catch((error: unknown) => {
    logger(`BlueZ Device1.Pair() later returned error: ${errorMessage(error)}`);
  });

  try {
    const result = await Promise.race([
      pairPromise.then(() => 'method-returned' as const),
      waitForBluezBooleanProperty(properties, 'org.bluez.Device1', 'Paired', true, timeoutMs).then(() => 'paired-property' as const)
    ]);
    logger(`BlueZ pairing completed via ${result}.`);
  } catch (error) {
    if ((await getBluezBoolean(properties, 'org.bluez.Device1', 'Paired')) === true) {
      logger(`BlueZ pairing method errored after Paired=true; continuing. Error was: ${errorMessage(error)}`);
      return;
    }
    throw error;
  }
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

type BluezObjects = Record<string, Record<string, Record<string, unknown>>>;
type BluezVariantConstructor = new (signature: string, value: unknown) => unknown;
type BluezInterfaceConstructor = new (name: string) => BluezServiceInterface;
type BluezAgentInterfaceConstructor = new () => BluezServiceInterface;

interface BluezObjectManager {
  GetManagedObjects(): Promise<BluezObjects>;
  on(event: 'InterfacesAdded', listener: (path: string, interfaces: Record<string, Record<string, unknown>>) => void): void;
  off(event: 'InterfacesAdded', listener: (path: string, interfaces: Record<string, Record<string, unknown>>) => void): void;
}

interface BluezAdapter {
  StartDiscovery(): Promise<void>;
  StopDiscovery(): Promise<void>;
  SetDiscoveryFilter(filter: Record<string, unknown>): Promise<void>;
}

interface BluezDevice {
  Pair(): Promise<void>;
}

interface BluezProperties {
  Get(interfaceName: string, propertyName: string): Promise<unknown>;
  Set(interfaceName: string, propertyName: string, value: unknown): Promise<void>;
}

interface BluezAgentManager {
  RegisterAgent(path: string, capability: string): Promise<void>;
  UnregisterAgent(path: string): Promise<void>;
  RequestDefaultAgent(path: string): Promise<void>;
}

interface BluezServiceInterface {
  $name?: string;
}

function loadDbusNext(): { systemBus: () => BluezBus; Variant: BluezVariantConstructor; Interface: BluezInterfaceConstructor } {
  try {
    const dbus = requireOptional('dbus-next') as {
      systemBus: () => BluezBus;
      Variant: BluezVariantConstructor;
      interface: { Interface: BluezInterfaceConstructor };
    };
    return { systemBus: dbus.systemBus, Variant: dbus.Variant, Interface: dbus.interface.Interface };
  } catch (error) {
    throw new Error(`BlueZ D-Bus pairing requires the optional "dbus-next" dependency. Run npm install before using pair --bluez. ${errorMessage(error)}`);
  }
}

interface BluezBus {
  getProxyObject(service: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  export(path: string, iface: BluezServiceInterface): void;
  unexport(path: string, iface: BluezServiceInterface): void;
  disconnect(): void;
}

function findBluezAdapterPath(objects: BluezObjects): string | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    if (interfaces['org.bluez.Adapter1']) return path;
  }
  return null;
}

async function registerBluezPairingAgent({
  bus,
  Interface,
  capability,
  logger
}: {
  bus: BluezBus;
  Interface: BluezInterfaceConstructor;
  capability: LinuxAgentCapability;
  logger: NonNullable<ConnectOptions['logger']>;
}): Promise<{ path: string; iface: BluezServiceInterface; stop: () => Promise<void> }> {
  const path = '/org/node_red_contrib_truma_inetx/agent';
  const AgentInterface = createBluezAgentInterface(Interface, logger);
  const iface = new AgentInterface();
  bus.export(path, iface);

  const object = await bus.getProxyObject('org.bluez', '/org/bluez');
  const manager = object.getInterface('org.bluez.AgentManager1') as BluezAgentManager;
  await manager.RegisterAgent(path, capability);
  await manager.RequestDefaultAgent(path);
  logger(`Registered in-process BlueZ D-Bus pairing agent ${path} with ${capability} capability.`);

  return {
    path,
    iface,
    stop: async () => {
      await manager.UnregisterAgent(path).catch((error: unknown) => logger(`Warning: could not unregister BlueZ D-Bus pairing agent: ${errorMessage(error)}`));
      bus.unexport(path, iface);
    }
  };
}

function createBluezAgentInterface(Interface: BluezInterfaceConstructor, logger: NonNullable<ConnectOptions['logger']>): BluezAgentInterfaceConstructor {
  class TrumaBluezAgent extends Interface {
    constructor() {
      super('org.bluez.Agent1');
    }

    Release(): void {
      logger('BlueZ agent Release.');
    }

    RequestPinCode(device: string): string {
      logger(`BlueZ agent RequestPinCode for ${device}; returning empty PIN.`);
      return '';
    }

    DisplayPinCode(device: string, pinCode: string): void {
      logger(`BlueZ agent DisplayPinCode for ${device}: ${pinCode}.`);
    }

    RequestPasskey(device: string): number {
      logger(`BlueZ agent RequestPasskey for ${device}; returning 0.`);
      return 0;
    }

    DisplayPasskey(device: string, passkey: number, entered: number): void {
      logger(`BlueZ agent DisplayPasskey for ${device}: ${passkey} (${entered} entered).`);
    }

    RequestConfirmation(device: string, passkey: number): void {
      logger(`BlueZ agent auto-confirming passkey ${passkey} for ${device}.`);
    }

    RequestAuthorization(device: string): void {
      logger(`BlueZ agent authorizing ${device}.`);
    }

    AuthorizeService(device: string, uuid: string): void {
      logger(`BlueZ agent authorizing service ${uuid} for ${device}.`);
    }

    Cancel(): void {
      logger('BlueZ agent Cancel.');
    }
  }

  (TrumaBluezAgent as unknown as { configureMembers(members: unknown): void }).configureMembers({
    methods: {
      Release: { inSignature: '', outSignature: '' },
      RequestPinCode: { inSignature: 'o', outSignature: 's' },
      DisplayPinCode: { inSignature: 'os', outSignature: '' },
      RequestPasskey: { inSignature: 'o', outSignature: 'u' },
      DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      RequestAuthorization: { inSignature: 'o', outSignature: '' },
      AuthorizeService: { inSignature: 'os', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' }
    }
  });

  return TrumaBluezAgent as unknown as BluezAgentInterfaceConstructor;
}

async function setBluezDiscoveryFilter(
  adapter: BluezAdapter,
  Variant: BluezVariantConstructor,
  serviceUuid: string | undefined,
  logger: NonNullable<ConnectOptions['logger']>
): Promise<void> {
  const filters: Array<{ name: string; filter: Record<string, unknown> }> = [
    {
      name: 'transport',
      filter: { Transport: new Variant('s', 'le') }
    },
    {
      name: 'duplicates',
      filter: { DuplicateData: new Variant('b', false) }
    }
  ];
  if (serviceUuid) {
    filters.push({
      name: 'service UUID',
      filter: { UUIDs: new Variant('as', [serviceUuid]) }
    });
  }

  for (const { name, filter } of filters) {
    await adapter.SetDiscoveryFilter(filter)
      .then(() => logger(`BlueZ discovery filter applied: ${name}.`))
      .catch((error: unknown) => logger(`Warning: could not set BlueZ discovery filter (${name}): ${errorMessage(error)}`));
  }
}

async function waitForBluezDevice({
  objectManager,
  initialObjects,
  namePrefix,
  serviceUuid,
  timeoutMs,
  logger
}: {
  objectManager: BluezObjectManager;
  initialObjects: BluezObjects;
  namePrefix: string;
  serviceUuid: string | undefined;
  timeoutMs: number;
  logger: NonNullable<ConnectOptions['logger']>;
}): Promise<{ path: string; address: string | null }> {
  const initialMatch = findBluezDevice(initialObjects, { namePrefix, serviceUuid });
  if (initialMatch) return initialMatch;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      objectManager.off('InterfacesAdded', onInterfacesAdded);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ to discover ${namePrefix}.`));
    }, timeoutMs);

    const onInterfacesAdded = (path: string, interfaces: Record<string, Record<string, unknown>>) => {
      const match = findBluezDevice({ [path]: interfaces }, { namePrefix, serviceUuid });
      if (!match) return;
      clearTimeout(timeout);
      objectManager.off('InterfacesAdded', onInterfacesAdded);
      logger(`BlueZ InterfacesAdded matched ${namePrefix} at ${path}.`);
      resolve(match);
    };

    objectManager.on('InterfacesAdded', onInterfacesAdded);
  });
}

function findBluezDevice(objects: BluezObjects, { namePrefix, serviceUuid }: { namePrefix: string; serviceUuid: string | undefined }): { path: string; address: string | null } | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    const device = interfaces['org.bluez.Device1'];
    if (!device) continue;

    const name = String(unboxBluezValue(device.Name) || unboxBluezValue(device.Alias) || '');
    const address = nullableString(unboxBluezValue(device.Address));
    const uuids = Array.isArray(unboxBluezValue(device.UUIDs)) ? (unboxBluezValue(device.UUIDs) as unknown[]).map((uuid) => String(uuid).toLowerCase()) : [];
    if (name.startsWith(namePrefix)) return { path, address };
    if (serviceUuid && uuids.includes(serviceUuid.toLowerCase())) return { path, address };
  }
  return null;
}

async function getBluezBoolean(properties: BluezProperties, interfaceName: string, propertyName: string): Promise<boolean | null> {
  const value = await properties.Get(interfaceName, propertyName).catch(() => null);
  const unboxed = unboxBluezValue(value);
  return typeof unboxed === 'boolean' ? unboxed : null;
}

async function waitForBluezBooleanProperty(
  properties: BluezProperties,
  interfaceName: string,
  propertyName: string,
  expected: boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getBluezBoolean(properties, interfaceName, propertyName)) === expected) return;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ ${propertyName}=${expected}.`);
}

async function getBluezString(properties: BluezProperties, interfaceName: string, propertyName: string): Promise<string | null> {
  const value = await properties.Get(interfaceName, propertyName).catch(() => null);
  return nullableString(unboxBluezValue(value));
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizeCompactUuid(uuid: string): string {
  return uuid.toLowerCase().replaceAll('-', '');
}

function formatCanonicalUuid(uuid: string): string {
  const compact = normalizeCompactUuid(uuid);
  if (compact.length === 4) return `0000${compact}-0000-1000-8000-00805f9b34fb`;
  if (compact.length !== 32) return uuid.toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function unboxBluezValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) return value.value;
  return value;
}

async function startLinuxPairingAgent({
  enabled,
  capability,
  logger
}: {
  enabled: boolean;
  capability: LinuxAgentCapability;
  logger: NonNullable<ConnectOptions['logger']>;
}): Promise<{ started: boolean; stop: () => Promise<void> }> {
  if (process.platform !== 'linux' || !enabled) return { started: false, stop: async () => {} };

  logger(`Starting private BlueZ pairing agent with ${capability} capability.`);
  const child = spawn('bluetoothctl', [], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  await waitForSpawn(child);
  const monitor = monitorBluetoothctl(child, logger);
  child.stdin.write('power on\n');
  await delay(300);
  await runBluetoothctlCommand(child, monitor, `agent ${capability}`, /Agent registered|Agent is already registered/i, /Failed to register agent object/i, 5000);
  await runBluetoothctlCommand(child, monitor, 'default-agent', /Default agent request successful/i, /No agent is registered|Failed/i, 5000);
  logger('Private BlueZ pairing agent is registered as default.');

  return {
    started: true,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.stdin.write('quit\n');
      await Promise.race([exited, delay(800)]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  };
}

async function startLinuxPairingControllerTweaks({
  enabled,
  legacyPairing,
  disablePrivacy,
  powerCycle,
  restore = true,
  logger
}: {
  enabled: boolean;
  legacyPairing: boolean;
  disablePrivacy: boolean;
  powerCycle: boolean;
  restore?: boolean;
  logger: NonNullable<ConnectOptions['logger']>;
}): Promise<{ started: boolean; stop: () => Promise<void> }> {
  if (process.platform !== 'linux' || !enabled) return { started: false, stop: async () => {} };

  logger('Applying temporary BlueZ controller pairing settings with btmgmt.');
  const info = await runBtmgmt(['info'], 3000).catch((error: unknown) => {
    throw new Error(`Could not inspect BlueZ controller settings with btmgmt: ${errorMessage(error)}`);
  });
  logger(`Initial btmgmt settings: ${summarizeBtmgmtSettings(info.stdout)}.`);
  const hadSecureConnections = /(?:current settings|settings):[^\n]*secure-conn/i.test(info.stdout);
  const hadPrivacy = /(?:current settings|settings):[^\n]*privacy/i.test(info.stdout);
  if (powerCycle) {
    logger('Power-cycling the Bluetooth controller before applying pairing settings.');
    await runBtmgmt(['power', 'off'], 5000).catch((error: unknown) => {
      throw new Error(`Could not power off Bluetooth controller with "btmgmt power off": ${errorMessage(error)}`);
    });
    await delay(500);
  }
  if (legacyPairing) {
    await runBtmgmt(['sc', 'off'], 5000).catch((error: unknown) => {
      throw new Error(`Could not disable BlueZ Secure Connections with "btmgmt sc off": ${errorMessage(error)}`);
    });
    logger(`BlueZ Secure Connections disabled for pairing${hadSecureConnections ? '; it will be restored afterwards' : ''}.`);
  }
  if (disablePrivacy) {
    await runBtmgmt(['privacy', 'off'], 5000).catch((error: unknown) => {
      throw new Error(`Could not disable BlueZ privacy with "btmgmt privacy off": ${errorMessage(error)}`);
    });
    logger(`BlueZ privacy disabled for pairing${hadPrivacy ? '; it will be restored afterwards' : ''}.`);
  }
  await runBtmgmt(['io-cap', '3'], 5000)
    .then(() => logger('BlueZ controller IO capability set to NoInputNoOutput for pairing.'))
    .catch((error: unknown) => logger(`Warning: could not set BlueZ IO capability with "btmgmt io-cap 3": ${errorMessage(error)}`));
  if (powerCycle) {
    await runBtmgmt(['power', 'on'], 5000).catch((error: unknown) => {
      throw new Error(`Could not power on Bluetooth controller with "btmgmt power on": ${errorMessage(error)}`);
    });
    await delay(1000);
  }
  await runBtmgmt(['info'], 3000)
    .then((afterInfo) => logger(`Post-legacy btmgmt settings: ${summarizeBtmgmtSettings(afterInfo.stdout)}.`))
    .catch((error: unknown) => logger(`Warning: could not re-read btmgmt settings: ${errorMessage(error)}`));

  return {
    started: true,
    stop: async () => {
      if (!restore) return;
      if (hadPrivacy && disablePrivacy) {
        await runBtmgmt(['privacy', 'on'], 5000)
          .then(() => logger('Restored BlueZ privacy with btmgmt.'))
          .catch((error: unknown) => logger(`Warning: could not restore BlueZ privacy with "btmgmt privacy on": ${errorMessage(error)}`));
      }
      if (hadSecureConnections && legacyPairing) {
        await runBtmgmt(['sc', 'on'], 5000)
          .then(() => logger('Restored BlueZ Secure Connections with btmgmt.'))
          .catch((error: unknown) => logger(`Warning: could not restore BlueZ Secure Connections with "btmgmt sc on": ${errorMessage(error)}`));
      }
    }
  };
}

function summarizeBtmgmtSettings(stdout: string): string {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /settings:/i.test(value));
  return line ?? '<settings unavailable>';
}

async function runBtmgmt(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runProcess('btmgmt', args, timeoutMs);
  } catch (error) {
    const interactive = await runInteractiveBtmgmt(args, timeoutMs).catch((interactiveError: unknown) => {
      throw new Error(`${errorMessage(error)}; interactive btmgmt fallback also failed: ${errorMessage(interactiveError)}`);
    });
    return interactive;
  }
}

function runInteractiveBtmgmt(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('btmgmt', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${timeoutMs}ms running interactive btmgmt ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('spawn', () => {
      child.stdin.write(`${args.join(' ')}\n`);
      child.stdin.write('quit\n');
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`interactive btmgmt ${args.join(' ')} exited with ${code ?? 'unknown status'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${timeoutMs}ms running ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(new Error(`Could not start bluetoothctl for BlueZ pairing agent: ${error.message}`));
    });
  });
}

interface BluetoothctlMonitor {
  lines: string[];
  waiters: Array<() => void>;
}

function monitorBluetoothctl(child: ChildProcessWithoutNullStreams, logger: NonNullable<ConnectOptions['logger']>): BluetoothctlMonitor {
  const monitor: BluetoothctlMonitor = {
    lines: [],
    waiters: []
  };

  const logChunk = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      monitor.lines.push(trimmed);
      if (monitor.lines.length > 80) monitor.lines.shift();
      if (/(agent|authorize|confirm|passkey|failed|error|not available)/i.test(trimmed)) logger(`[bluez-agent] ${trimmed}`);
      if (/authorize service|confirm passkey|confirm.*yes\/no|accept.*yes\/no/i.test(trimmed)) {
        logger('[bluez-agent] Auto-confirming pairing prompt.');
        child.stdin.write('yes\n');
      }
    }
    const waiters = monitor.waiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  child.stdout.on('data', logChunk);
  child.stderr.on('data', logChunk);
  return monitor;
}

async function runBluetoothctlCommand(
  child: ChildProcessWithoutNullStreams,
  monitor: BluetoothctlMonitor,
  command: string,
  successPattern: RegExp,
  failurePattern: RegExp,
  timeoutMs: number
): Promise<void> {
  const startIndex = monitor.lines.length;
  child.stdin.write(`${command}\n`);
  await waitForBluetoothctlLine(monitor, startIndex, successPattern, failurePattern, timeoutMs, command);
}

async function waitForBluetoothctlLine(
  monitor: BluetoothctlMonitor,
  startIndex: number,
  successPattern: RegExp,
  failurePattern: RegExp,
  timeoutMs: number,
  command: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: string | null = null;

  while (Date.now() < deadline) {
    for (const line of monitor.lines.slice(startIndex)) {
      if (successPattern.test(line)) return;
      if (failurePattern.test(line)) lastFailure = line;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 100);
      monitor.waiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  const recent = monitor.lines.slice(-8).join(' | ') || '<no bluetoothctl output>';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for bluetoothctl command "${command}" to succeed.${lastFailure ? ` Last failure: ${lastFailure}.` : ''} Recent output: ${recent}`);
}
