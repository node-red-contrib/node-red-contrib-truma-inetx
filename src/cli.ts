import { discoverTrumaTopology, readTrumaSettings, shutdownBluetooth } from './index.js';

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
  if (command !== 'read' && command !== 'discover') throw new Error(`Unknown command: ${command}`);
  const options = parseReadOptions(args);

  const logger = process.env.TRUMA_DEBUG ? (message: string) => process.stderr.write(`[truma-debug] ${message}\n`) : undefined;
  try {
    const result =
      command === 'discover'
        ? await discoverTrumaTopology({ connectRetries: 3, logger })
        : await readTrumaSettings({
            connectRetries: 3,
            logger,
            topics: options.topics,
            groups: options.groups
          });
    await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await shutdownBluetooth();
  }
}

interface ReadCliOptions {
  topics?: string[];
  groups?: number[];
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

Reads Truma iNet X settings over BLE and prints one JSON document to stdout.
Use discover to list advertised topic names and device groups without reading group parameter payloads.
Use --group to read only explicit device groups. --topic only registers/filters topic names; it does not infer groups.

Set TRUMA_DEBUG=1 to print BLE/protocol diagnostics to stderr.
`);
}
