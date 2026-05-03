import { readFile } from 'node:fs/promises';

import { discoverTrumaTopology, pairTruma, prepareVictronBluez, readTrumaSettings, setTrumaParameter, shutdownBluetooth } from './index.js';
import type { LinuxAgentCapability } from './index.js';
import type { SettingsJson } from './settings.js';
import type { TrumaValue } from './truma-frame.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  installSignalCleanup();

  let command = argv[0] ?? 'read';
  let args = argv.slice(1);
  if (command === 'read' && args[0] === 'discover') {
    command = 'discover';
    args = args.slice(1);
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'victron') command = 'victron-prepare';
  if (command !== 'read' && command !== 'discover' && command !== 'set' && command !== 'pair' && command !== 'victron-prepare') {
    throw new Error(`Unknown command: ${command}`);
  }

  const logger = process.env.TRUMA_DEBUG ? (message: string) => process.stderr.write(`[truma-debug] ${message}\n`) : undefined;
  try {
    const result = await runCommand(command, args, logger);
    await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await shutdownBluetooth();
  }
}

async function runCommand(command: string, args: string[], logger: ((message: string) => void) | undefined) {
  if (command === 'victron-prepare') {
    const options = parseVictronPrepareOptions(args);
    return prepareVictronBluez({ logger, disablePrivacy: options.disablePrivacy });
  }

  if (command === 'discover') {
    const options = parseReadOptions(args);
    return discoverTrumaTopology({ connectRetries: 3, logger, backend: options.backend });
  }
  if (command === 'pair') {
    const options = parsePairOptions(args);
    return pairTruma({
      connectRetries: 3,
      logger,
      holdMs: options.holdMs,
      linuxAgent: options.linuxAgent,
      linuxAgentCapability: options.linuxAgentCapability,
      linuxPairingMethod: options.linuxPairingMethod,
      linuxLegacyPairing: options.linuxLegacyPairing,
      linuxLegacyPowerCycle: options.linuxLegacyPowerCycle,
      linuxDisablePrivacy: options.linuxDisablePrivacy
    });
  }
  if (command === 'set') {
    const options = parseSetOptions(args);
    const tree = options.treePath ? await loadSettingsTree(options.treePath) : null;
    const targetGroup = options.group ?? inferSingleTopicGroup(tree, options.topic);
    return setTrumaParameter({
      connectRetries: 3,
      logger,
      backend: options.backend,
      targetGroup,
      topic: options.topic,
      parameter: options.parameter,
      value: options.value
    });
  }

  const options = parseReadOptions(args);
  const tree = options.treePath ? await loadSettingsTree(options.treePath) : null;
  const topics = options.topics ?? [];
  const groups = options.groups ?? (tree ? inferReadGroups(tree, topics) : undefined);
  return readTrumaSettings({
    connectRetries: 3,
    logger,
    backend: options.backend,
    topics: options.topics,
    groups
  });
}

interface ReadCliOptions {
  topics?: string[];
  groups?: number[];
  treePath?: string;
  backend?: 'noble' | 'bluez';
}

interface SetCliOptions {
  group?: number;
  treePath?: string;
  topic: string;
  parameter: string;
  value: TrumaValue;
  backend?: 'noble' | 'bluez';
}

interface PairCliOptions {
  holdMs: number;
  linuxAgent?: boolean;
  linuxAgentCapability?: LinuxAgentCapability;
  linuxPairingMethod?: 'noble-trigger' | 'bluez';
  linuxLegacyPairing?: boolean;
  linuxLegacyPowerCycle?: boolean;
  linuxDisablePrivacy?: boolean;
}

interface VictronPrepareCliOptions {
  disablePrivacy: boolean;
}

function parseVictronPrepareOptions(args: string[]): VictronPrepareCliOptions {
  let disablePrivacy = false;

  for (const arg of args) {
    if (arg === '--disable-privacy') {
      disablePrivacy = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown victron-prepare option: ${arg}`);
  }

  return { disablePrivacy };
}

function parseReadOptions(args: string[]): ReadCliOptions {
  const topics: string[] = [];
  const groups: number[] = [];
  let treePath: string | undefined;
  let backend: 'noble' | 'bluez' | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--bluez') {
      backend = 'bluez';
      continue;
    }
    if (arg === '--noble') {
      backend = 'noble';
      continue;
    }
    if (arg === '--topics' || arg === '--topic') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a comma-separated topic list.`);
      topics.push(...splitTopics(value));
      index += 1;
      continue;
    }
    if (arg.startsWith('--topics=')) {
      topics.push(...splitTopics(arg.slice('--topics='.length)));
      continue;
    }
    if (arg.startsWith('--topic=')) {
      topics.push(...splitTopics(arg.slice('--topic='.length)));
      continue;
    }
    if (arg === '--groups' || arg === '--group') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a comma-separated device group list.`);
      groups.push(...splitGroups(value));
      index += 1;
      continue;
    }
    if (arg.startsWith('--groups=')) {
      groups.push(...splitGroups(arg.slice('--groups='.length)));
      continue;
    }
    if (arg.startsWith('--group=')) {
      groups.push(...splitGroups(arg.slice('--group='.length)));
      continue;
    }
    if (arg === '--tree') {
      treePath = parseRequiredText(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--tree=')) {
      treePath = parseRequiredText(arg.slice('--tree='.length), arg);
      continue;
    }
    throw new Error(`Unknown read option: ${arg}`);
  }

  return {
    ...(topics.length ? { topics: [...new Set(topics)] } : {}),
    ...(groups.length ? { groups: [...new Set(groups)] } : {}),
    ...(treePath ? { treePath } : {}),
    ...(backend ? { backend } : {})
  };
}

function splitTopics(value: string): string[] {
  return value
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function splitGroups(value: string): number[] {
  return value
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
    .map(parseGroup);
}

function parseSetOptions(args: string[]): SetCliOptions {
  let group: number | undefined;
  let treePath: string | undefined;
  let topic: string | undefined;
  let parameter: string | undefined;
  let value: TrumaValue | undefined;
  let backend: 'noble' | 'bluez' | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--bluez') {
      backend = 'bluez';
      continue;
    }
    if (arg === '--noble') {
      backend = 'noble';
      continue;
    }

    if (arg === '--group') {
      group = parseRequiredGroup(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--group=')) {
      group = parseGroup(arg.slice('--group='.length));
      continue;
    }
    if (arg === '--tree') {
      treePath = parseRequiredText(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--tree=')) {
      treePath = parseRequiredText(arg.slice('--tree='.length), arg);
      continue;
    }
    if (arg === '--topic') {
      topic = parseRequiredText(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--topic=')) {
      topic = parseRequiredText(arg.slice('--topic='.length), arg);
      continue;
    }
    if (arg === '--param' || arg === '--parameter') {
      parameter = parseRequiredText(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--param=')) {
      parameter = parseRequiredText(arg.slice('--param='.length), arg);
      continue;
    }
    if (arg.startsWith('--parameter=')) {
      parameter = parseRequiredText(arg.slice('--parameter='.length), arg);
      continue;
    }
    if (arg === '--value') {
      value = parseSetValue(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--value=')) {
      value = parseSetValue(arg.slice('--value='.length), arg);
      continue;
    }
    throw new Error(`Unknown set option: ${arg}`);
  }

  if (group === undefined && !treePath) throw new Error('set requires --group or --tree.');
  if (!topic) throw new Error('set requires --topic.');
  if (!parameter) throw new Error('set requires --param.');
  if (value === undefined) throw new Error('set requires --value.');

  return { group, treePath, topic, parameter, value, ...(backend ? { backend } : {}) };
}

function parsePairOptions(args: string[]): PairCliOptions {
  let holdMs = 20000;
  let linuxAgent: boolean | undefined;
  let linuxAgentCapability: LinuxAgentCapability | undefined;
  let linuxPairingMethod: 'noble-trigger' | 'bluez' | undefined;
  let linuxLegacyPairing = false;
  let linuxLegacyPowerCycle = false;
  let linuxDisablePrivacy = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--hold-ms') {
      holdMs = parsePositiveInteger(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--hold-ms=')) {
      holdMs = parsePositiveInteger(arg.slice('--hold-ms='.length), arg);
      continue;
    }
    if (arg === '--linux-agent') {
      linuxAgent = true;
      continue;
    }
    if (arg === '--no-linux-agent') {
      linuxAgent = false;
      continue;
    }
    if (arg === '--bluez') {
      linuxPairingMethod = 'bluez';
      continue;
    }
    if (arg === '--noble-trigger') {
      linuxPairingMethod = 'noble-trigger';
      continue;
    }
    if (arg === '--legacy-pairing') {
      linuxLegacyPairing = true;
      continue;
    }
    if (arg === '--legacy-power-cycle') {
      linuxLegacyPairing = true;
      linuxLegacyPowerCycle = true;
      continue;
    }
    if (arg === '--disable-privacy') {
      linuxDisablePrivacy = true;
      continue;
    }
    if (arg === '--agent-capability') {
      linuxAgentCapability = parseLinuxAgentCapability(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--agent-capability=')) {
      linuxAgentCapability = parseLinuxAgentCapability(arg.slice('--agent-capability='.length), arg);
      continue;
    }
    throw new Error(`Unknown pair option: ${arg}`);
  }

  return {
    holdMs,
    ...(linuxAgent === undefined ? {} : { linuxAgent }),
    ...(linuxAgentCapability ? { linuxAgentCapability } : {}),
    ...(linuxPairingMethod ? { linuxPairingMethod } : {}),
    ...(linuxLegacyPairing ? { linuxLegacyPairing } : {}),
    ...(linuxLegacyPowerCycle ? { linuxLegacyPowerCycle } : {}),
    ...(linuxDisablePrivacy ? { linuxDisablePrivacy } : {})
  };
}

function parseRequiredGroup(value: string | undefined, option: string): number {
  if (!value) throw new Error(`${option} requires a device group.`);
  return parseGroup(value);
}

function parseRequiredText(value: string | undefined, option: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${option} requires a value.`);
  return normalized;
}

function parsePositiveInteger(value: string | undefined, option: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error(`${option} requires a positive integer.`);
  return Number.parseInt(value, 10);
}

function parseLinuxAgentCapability(value: string | undefined, option: string): LinuxAgentCapability {
  const capabilities: LinuxAgentCapability[] = ['DisplayOnly', 'DisplayYesNo', 'KeyboardOnly', 'NoInputNoOutput', 'KeyboardDisplay'];
  if (!value || !capabilities.includes(value as LinuxAgentCapability)) {
    throw new Error(`${option} requires one of: ${capabilities.join(', ')}.`);
  }
  return value as LinuxAgentCapability;
}

function parseSetValue(value: string | undefined, option: string): TrumaValue {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') throw new Error(`${option} requires a value.`);
  if (/^(on|true)$/i.test(normalized)) return 1;
  if (/^(off|false)$/i.test(normalized)) return 0;
  if (/^null$/i.test(normalized)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (/^(?:".*"|\[.*\]|\{.*\})$/.test(normalized)) return JSON.parse(normalized) as TrumaValue;
  return normalized;
}

function parseGroup(value: string): number {
  const normalized = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{1,4}$/i.test(normalized)) throw new Error(`Invalid device group: ${value}`);
  return Number.parseInt(normalized, 16);
}

async function loadSettingsTree(path: string): Promise<SettingsJson> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.topics)) throw new Error(`Invalid Truma settings tree: ${path}`);
  return parsed as unknown as SettingsJson;
}

function inferReadGroups(tree: SettingsJson, selectedTopics: string[]): number[] {
  const topicNames = selectedTopics.length ? selectedTopics : Object.keys(tree.topics);
  const groups = new Set<number>();

  for (const topicName of topicNames) {
    for (const group of readTopicGroups(tree, topicName)) groups.add(group);
  }

  if (!groups.size) throw new Error('Could not infer any device groups from the settings tree.');
  return [...groups].sort((left, right) => left - right);
}

function inferSingleTopicGroup(tree: SettingsJson | null, topicName: string): number {
  if (!tree) throw new Error(`set requires --group when no --tree is provided.`);
  const groups = readTopicGroups(tree, topicName);
  if (groups.length === 0) throw new Error(`Could not infer a group for topic ${topicName} from the settings tree.`);
  if (groups.length > 1) {
    throw new Error(`Topic ${topicName} has multiple groups (${groups.map(formatGroup).join(', ')}); pass --group explicitly.`);
  }
  return groups[0];
}

function readTopicGroups(tree: SettingsJson, topicName: string): number[] {
  const topic = tree.topics[topicName];
  const groups = new Set<number>();

  if (isRecord(topic)) {
    if (typeof topic.group === 'string') groups.add(parseGroup(topic.group));
    if (Array.isArray(topic.groups)) {
      for (const group of topic.groups) {
        if (typeof group === 'string') groups.add(parseGroup(group));
      }
    }
  }

  const diagnosticGroups = tree.diagnostics?.topicGroups?.[topicName];
  if (Array.isArray(diagnosticGroups)) {
    for (const group of diagnosticGroups) {
      if (typeof group === 'string') groups.add(parseGroup(group));
    }
  }

  return [...groups].sort((left, right) => left - right);
}

function formatGroup(group: number): string {
  return `0x${group.toString(16).padStart(4, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

function installSignalCleanup(): void {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownBluetooth();
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  truma-inetx discover
  truma-inetx pair
  truma-inetx pair --bluez
  truma-inetx pair --hold-ms 30000
  truma-inetx pair --agent-capability NoInputNoOutput
  truma-inetx pair --legacy-pairing
  truma-inetx pair --legacy-pairing --legacy-power-cycle
  truma-inetx pair --legacy-pairing --disable-privacy
  truma-inetx victron-prepare
  truma-inetx read
  truma-inetx read --bluez
  truma-inetx discover --bluez
  truma-inetx read --topics System,PowerSupply
  truma-inetx read --group 0201
  truma-inetx read --topic EnergySrc --group 0201
  truma-inetx read --tree truma-tree.json --topic Switches
  truma-inetx read --topic BluetoothDevice
  truma-inetx set --tree truma-tree.json --topic Switches --param ExternalLights --value 1
  truma-inetx set --group 0405 --topic Switches --param ExternalLights --value 1

Pairs with or reads/writes Truma iNet X settings over BLE and prints one JSON document to stdout.
Use pair while the iNet X display is in Bluetooth pairing mode. The command triggers OS-level pairing and holds the connection briefly.
Use pair --bluez on Linux/Venus OS to pair through bluetoothd D-Bus so BlueZ can persist the bond.
Use read/discover/set --bluez on Linux/Venus OS to access GATT through bluetoothd and the persisted bond.
On Linux, pair starts a quiet private bluetoothctl/BlueZ agent by default. Use --no-linux-agent to disable it.
Use --legacy-pairing to temporarily run "btmgmt sc off" around pairing when BlueZ Secure Connections breaks legacy SMP pairing.
Use --legacy-power-cycle with --legacy-pairing to power-cycle the controller while applying the setting.
Use --disable-privacy to temporarily run "btmgmt privacy off" around pairing.
Use victron-prepare to persist Venus OS BlueZ settings: power-cycle, sc off, io-cap 3.
Use discover to build a reusable settings tree with topic group ids.
Use --group to read only explicit device groups. --topic only registers/filters topic names; it does not infer groups.
Use --tree to infer groups for read/set from a previous discover JSON.
Use set with an explicit or tree-inferred device group, topic, parameter, and value. Switch values use 1/0.

Set TRUMA_DEBUG=1 to print BLE/protocol diagnostics to stderr.
`);
}
