import { discoverTrumaTopology, readTrumaSettings, setTrumaParameter, shutdownBluetooth } from './index.js';
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
  if (command !== 'read' && command !== 'discover' && command !== 'set') throw new Error(`Unknown command: ${command}`);

  const logger = process.env.TRUMA_DEBUG ? (message: string) => process.stderr.write(`[truma-debug] ${message}\n`) : undefined;
  try {
    const result = await runCommand(command, args, logger);
    await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await shutdownBluetooth();
  }
}

function runCommand(command: string, args: string[], logger: ((message: string) => void) | undefined) {
  if (command === 'discover') return discoverTrumaTopology({ connectRetries: 3, logger });
  if (command === 'set') {
    const options = parseSetOptions(args);
    return setTrumaParameter({
      connectRetries: 3,
      logger,
      targetGroup: options.group,
      topic: options.topic,
      parameter: options.parameter,
      value: options.value
    });
  }

  const options = parseReadOptions(args);
  return readTrumaSettings({
    connectRetries: 3,
    logger,
    topics: options.topics,
    groups: options.groups
  });
}

interface ReadCliOptions {
  topics?: string[];
  groups?: number[];
}

interface SetCliOptions {
  group: number;
  topic: string;
  parameter: string;
  value: TrumaValue;
}

function parseReadOptions(args: string[]): ReadCliOptions {
  const topics: string[] = [];
  const groups: number[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
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
    throw new Error(`Unknown read option: ${arg}`);
  }

  return {
    ...(topics.length ? { topics: [...new Set(topics)] } : {}),
    ...(groups.length ? { groups: [...new Set(groups)] } : {})
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
  let topic: string | undefined;
  let parameter: string | undefined;
  let value: TrumaValue | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
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

  if (group === undefined) throw new Error('set requires --group.');
  if (!topic) throw new Error('set requires --topic.');
  if (!parameter) throw new Error('set requires --param.');
  if (value === undefined) throw new Error('set requires --value.');

  return { group, topic, parameter, value };
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
  truma-inetx read
  truma-inetx read --topics System,PowerSupply
  truma-inetx read --group 0201
  truma-inetx read --topic EnergySrc --group 0201
  truma-inetx read --topic BluetoothDevice
  truma-inetx set --group 0405 --topic Switches --param ExternalLights --value 1

Reads Truma iNet X settings over BLE and prints one JSON document to stdout.
Use discover to list advertised topic names and device groups without reading group parameter payloads.
Use --group to read only explicit device groups. --topic only registers/filters topic names; it does not infer groups.
Use set with an explicit device group, topic, parameter, and value. Switch values use 1/0.

Set TRUMA_DEBUG=1 to print BLE/protocol diagnostics to stderr.
`);
}
