import { readTrumaSettings, shutdownBluetooth } from './index.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  installSignalCleanup();

  const command = argv[0] ?? 'read';
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command !== 'read') throw new Error(`Unknown command: ${command}`);
  const options = parseReadOptions(argv.slice(1));

  const logger = process.env.TRUMA_DEBUG ? (message: string) => process.stderr.write(`[truma-debug] ${message}\n`) : undefined;
  try {
    const settings = await readTrumaSettings({
      connectRetries: 3,
      logger,
      topics: options.topics
    });
    await writeStdout(`${JSON.stringify(settings, null, 2)}\n`);
  } finally {
    await shutdownBluetooth();
  }
}

interface ReadCliOptions {
  topics?: string[];
}

function parseReadOptions(args: string[]): ReadCliOptions {
  const topics: string[] = [];

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
    throw new Error(`Unknown read option: ${arg}`);
  }

  return topics.length ? { topics: [...new Set(topics)] } : {};
}

function splitTopics(value: string): string[] {
  return value
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
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
  truma-inetx read
  truma-inetx read --topics System,PowerSupply
  truma-inetx read --topic BluetoothDevice

Reads Truma iNet X settings over BLE and prints one JSON document to stdout.
Use --topics to request only specific iNet X topic names for protocol diagnostics.

Set TRUMA_DEBUG=1 to print BLE/protocol diagnostics to stderr.
`);
}
