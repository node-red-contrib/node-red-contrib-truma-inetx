import { readTrumaSettings, shutdownBluetooth } from './index.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  installSignalCleanup();

  const command = argv[0] ?? 'read';
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command !== 'read') throw new Error(`Unknown command: ${command}`);
  if (argv.length > 1) throw new Error('The read command does not accept options.');

  const logger = process.env.TRUMA_DEBUG ? (message: string) => process.stderr.write(`[truma-debug] ${message}\n`) : undefined;
  const settings = await readTrumaSettings({
    connectRetries: 3,
    logger
  });
  process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
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

Reads Truma iNet X settings over BLE and prints one JSON document to stdout.

Set TRUMA_DEBUG=1 to print BLE/protocol diagnostics to stderr.
`);
}
