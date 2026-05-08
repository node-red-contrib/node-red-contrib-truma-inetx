import { readFile } from 'node:fs/promises';

import { Command, Option } from 'commander';

import { discover, get, pair, set, shutdownBluetooth, type BluetoothBackendName } from './index.js';
import type { SettingsJson } from './settings.js';
import type { TrumaValue } from './truma-frame.js';

type Logger = (message: string) => void;

interface GlobalCliOptions {
  bluetooth: BluetoothBackendName;
  debug?: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  installSignalCleanup();

  const program = new Command();
  program
    .name('truma-inetx')
    .description('Read and write Truma iNet X settings over Bluetooth LE.')
    .showHelpAfterError()
    .addOption(new Option('--bluetooth <backend>', 'Bluetooth backend').choices(['auto', 'bluez', 'noble']).default('auto'))
    .option('--debug', 'print Bluetooth/protocol diagnostics to stderr');

  program
    .command('discover')
    .description('Discover the dynamic Truma topic tree and group mapping.')
    .action(async () => {
      const globals = globalOptions(program);
      const result = await discover({ connectRetries: 3, logger: loggerFor(globals), bluetooth: globals.bluetooth });
      await writeJson(result);
    });

  program
    .command('get')
    .description('Get all settings or selected topics.')
    .argument('[topics...]', 'topic names to get')
    .action(async (topics: string[]) => {
      const globals = globalOptions(program);
      const selectedTopics = topics.flatMap(splitTopics).filter(Boolean);
      const result = await get({
        connectRetries: 3,
        logger: loggerFor(globals),
        bluetooth: globals.bluetooth,
        ...(selectedTopics.length ? { topics: selectedTopics } : {})
      });
      await writeJson(result);
    });

  program
    .command('set')
    .description('Set one Truma parameter.')
    .argument('<topic>', 'topic name')
    .argument('<parameter>', 'parameter name')
    .argument('<value>', 'value to write')
    .option('--tree <path>', 'settings tree JSON from discover')
    .option('--group <group>', 'device group, for example 0405 or 0x0405')
    .action(async (topic: string, parameter: string, rawValue: string, options: { tree?: string; group?: string }) => {
      const globals = globalOptions(program);
      const tree = options.tree ? await loadSettingsTree(options.tree) : null;
      const targetGroup = options.group ? parseGroup(options.group) : inferSingleTopicGroup(tree, topic);
      const result = await set({
        connectRetries: 3,
        logger: loggerFor(globals),
        bluetooth: globals.bluetooth,
        targetGroup,
        topic,
        parameter,
        value: parseSetValue(rawValue)
      });
      await writeJson(result);
    });

  program
    .command('pair')
    .description('Pair with a Truma iNet X while the display is in Bluetooth pairing mode.')
    .action(async () => {
      const globals = globalOptions(program);
      const result = await pair({
        connectRetries: 3,
        logger: loggerFor(globals),
        bluetooth: globals.bluetooth,
        holdMs: 30000,
        linuxAgentCapability: 'NoInputNoOutput',
        linuxLegacyPowerCycle: false,
        linuxDisablePrivacy: false
      });
      await writeJson(result);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    await shutdownBluetooth();
  }
}

function globalOptions(program: Command): GlobalCliOptions {
  return program.opts<GlobalCliOptions>();
}

function loggerFor({ debug }: GlobalCliOptions): Logger {
  return debug ? (message) => process.stderr.write(`[truma-debug] ${message}\n`) : () => {};
}

function splitTopics(value: string): string[] {
  return value
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function parseSetValue(value: string): TrumaValue {
  const normalized = value.trim();
  if (/^(on|true)$/i.test(normalized)) return 1;
  if (/^(off|false)$/i.test(normalized)) return 0;
  if (/^null$/i.test(normalized)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (/^(?:".*"|\[.*\]|\{.*\})$/.test(normalized)) return JSON.parse(normalized) as TrumaValue;
  return normalized;
}

async function loadSettingsTree(path: string): Promise<SettingsJson> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.topics)) throw new Error(`Invalid Truma settings tree: ${path}`);
  return parsed as unknown as SettingsJson;
}

function inferSingleTopicGroup(tree: SettingsJson | null, topicName: string): number {
  if (!tree) throw new Error('set requires --group or --tree.');
  const groups = readTopicGroups(tree, topicName);
  if (groups.length === 0) throw new Error(`Could not infer a group for topic ${topicName} from the settings tree.`);
  if (groups.length > 1) throw new Error(`Topic ${topicName} has multiple groups (${groups.map(formatGroup).join(', ')}); pass --group.`);
  const [group] = groups;
  if (group === undefined) throw new Error(`Could not infer a group for topic ${topicName}.`);
  return group;
}

function readTopicGroups(tree: SettingsJson, topicName: string): number[] {
  const topic = tree.topics[topicName];
  const groups = new Set<number>();

  if (isRecord(topic)) {
    if (typeof topic.group === 'string') groups.add(parseGroup(topic.group));
    if (Array.isArray(topic.groups)) {
      for (const group of topic.groups) if (typeof group === 'string') groups.add(parseGroup(group));
    }
  }

  const diagnosticGroups = tree.diagnostics?.topicGroups?.[topicName];
  if (Array.isArray(diagnosticGroups)) {
    for (const group of diagnosticGroups) if (typeof group === 'string') groups.add(parseGroup(group));
  }

  return [...groups].sort((left, right) => left - right);
}

function parseGroup(value: string): number {
  const normalized = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{1,4}$/i.test(normalized)) throw new Error(`Invalid device group: ${value}`);
  return Number.parseInt(normalized, 16);
}

function formatGroup(group: number): string {
  return `0x${group.toString(16).padStart(4, '0')}`;
}

async function writeJson(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function installSignalCleanup(): void {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    await Promise.race([
      shutdownBluetooth(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 3000);
      })
    ]);
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}
