import fs from 'node:fs/promises';
import path from 'node:path';

import { connectToTruma, disconnectQuietly, readSoftwareRevision, scanTruma, shutdownBluetooth } from './ble.js';
import { decodeFirstCbor } from './cbor.js';
import { TrumaProtocol } from './protocol.js';
import { collectSettings, writeSettingsFiles } from './settings.js';

const DEFAULT_MARKDOWN_OUT = 'output/live-settings.md';
const DEFAULT_JSON_OUT = 'output/live-settings.json';
const DEFAULT_RAW_OUT = 'output/live-responses.txt';

export async function main() {
  installSignalCleanup();

  const [command, ...argv] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const options = parseOptions(argv);

  if (command === 'connect') {
    await connectCommand(options);
    return;
  }

  if (command === 'pair') {
    await pairCommand(options);
    return;
  }

  if (command === 'scan') {
    await scanCommand(options);
    return;
  }

  if (command === 'read') {
    await readCommand(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function scanCommand(options) {
  await scanTruma({
    namePrefix: options.name || undefined,
    scanServiceUuid: scanServiceUuidOption(options),
    timeoutMs: Number(options.timeout || 10000)
  });
}

async function connectCommand(options) {
  const session = await connectToTruma({
    namePrefix: options.name || undefined,
    scanServiceUuid: scanServiceUuidOption(options),
    timeoutMs: Number(options.timeout || 30000),
    connectTimeoutMs: Number(options.connectTimeout || 15000),
    discoverTimeoutMs: Number(options.discoverTimeout || 15000),
    connectRetries: Number(options.connectRetries || 3),
    warmupScanMs: Number(options.warmupScan || 0),
    resetBeforeConnect: options.resetBeforeConnect === true,
    connectDuringScan: options.connectDuringScan !== false,
    debug: options.debug === true
  });

  try {
    if (options.debug) console.log('[pair-debug] Step 6/8: reading software revision. No exact version is required.');
    const version = await readSoftwareRevision(session.characteristics);
    if (version) console.log(`Software revision: ${version}`);

    if (options.pairTrigger !== false) {
      if (options.debug) console.log('[pair-debug] Step 7/8: triggering pairing by subscribing to protected control characteristic.');
      console.log('Subscribing to control characteristic. If this Mac is not paired, macOS should show the pairing request.');
      const protocol = new TrumaProtocol(session.characteristics, { debug: options.debug === true });
      await protocol.triggerPairingOnly();
      console.log('Control subscription succeeded.');
    }

    if (options.hold) {
      if (options.debug) console.log('[pair-debug] Step 8/8: holding connection open so macOS/Truma can complete pairing.');
      console.log('Holding connection. Press Ctrl+C to disconnect.');
      await waitForever();
    }
  } finally {
    if (!options.hold) await disconnectQuietly(session.peripheral);
  }
}

async function pairCommand(options) {
  options.pairTrigger = true;
  options.hold = true;
  if (!Object.hasOwn(options, 'scanServiceUuid')) options.scanServiceUuid = normalizeUuidOption('truma');
  if (!options.connectTimeout) options.connectTimeout = '30000';
  if (!options.connectRetries) options.connectRetries = '3';
  await connectCommand(options);
}

async function readCommand(options) {
  const markdownOut = options.out || DEFAULT_MARKDOWN_OUT;
  const jsonOut = options.json === false ? null : options.json || DEFAULT_JSON_OUT;
  const rawOut = options.raw === false ? null : options.raw || DEFAULT_RAW_OUT;

  await fs.mkdir(path.dirname(markdownOut), { recursive: true });
  if (jsonOut) await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  if (rawOut) await fs.mkdir(path.dirname(rawOut), { recursive: true });

  const session = await connectToTruma({
    namePrefix: options.name || undefined,
    scanServiceUuid: scanServiceUuidOption(options),
    timeoutMs: Number(options.timeout || 30000),
    connectTimeoutMs: Number(options.connectTimeout || 15000),
    discoverTimeoutMs: Number(options.discoverTimeout || 15000),
    connectRetries: Number(options.connectRetries || 3),
    warmupScanMs: Number(options.warmupScan || 0),
    resetBeforeConnect: options.resetBeforeConnect === true,
    connectDuringScan: options.connectDuringScan !== false,
    debug: options.debug === true
  });

  try {
    const version = await readSoftwareRevision(session.characteristics);
    if (version) console.log(`Software revision: ${version}`);

    const protocol = new TrumaProtocol(session.characteristics, {
      debug: options.debug === true,
      timings: protocolTimingsOption(options)
    });
    const responses = await protocol.readAll();
    console.log(`Collected ${responses.length} response payload(s).`);
    if (rawOut) {
      await writeRawResponses(responses, rawOut);
      console.log(`Wrote ${rawOut}`);
    }

    const settings = collectSettings(responses);
    await writeSettingsFiles(settings, {
      markdownPath: markdownOut,
      jsonPath: jsonOut,
      redact: options.redact !== false
    });

    console.log(`Wrote ${markdownOut}`);
    if (jsonOut) console.log(`Wrote ${jsonOut}`);
  } finally {
    await disconnectQuietly(session.peripheral);
  }
}

function parseOptions(argv) {
  const options = { redact: true, pairTrigger: true };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === '--name') options.name = readValue();
    else if (arg === '--timeout') options.timeout = readValue();
    else if (arg === '--connect-timeout') options.connectTimeout = readValue();
    else if (arg === '--discover-timeout') options.discoverTimeout = readValue();
    else if (arg === '--connect-retries') options.connectRetries = readValue();
    else if (arg === '--warmup-scan') options.warmupScan = readValue();
    else if (arg === '--scan-service') options.scanServiceUuid = normalizeUuidOption(readValue());
    else if (arg === '--no-service-filter') options.scanServiceUuid = null;
    else if (arg === '--reset-before-connect') options.resetBeforeConnect = true;
    else if (arg === '--stop-scan-before-connect') options.connectDuringScan = false;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--out') options.out = readValue();
    else if (arg === '--json') options.json = readValue();
    else if (arg === '--no-json') options.json = false;
    else if (arg === '--raw') options.raw = readValue();
    else if (arg === '--no-raw') options.raw = false;
    else if (arg === '--no-redact') options.redact = false;
    else if (arg === '--response-idle') options.responseIdle = readValue();
    else if (arg === '--interleaved-settle') options.interleavedSettle = readValue();
    else if (arg === '--pipeline-settle') options.pipelineSettle = readValue();
    else if (arg === '--final-drain') options.finalDrain = readValue();
    else if (arg === '--no-pair-trigger') options.pairTrigger = false;
    else if (arg === '--hold') options.hold = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function scanServiceUuidOption(options) {
  return Object.hasOwn(options, 'scanServiceUuid') ? options.scanServiceUuid : undefined;
}

function normalizeUuidOption(value) {
  if (value === 'truma') return 'fc310001f3b211e88eb2f2801f1b9fd1';
  return value.toLowerCase().replaceAll('-', '');
}

function protocolTimingsOption(options) {
  const timings = {};

  assignNumberOption(timings, 'responseIdleMs', options.responseIdle, '--response-idle');
  assignNumberOption(timings, 'interleavedResponseSettleMs', options.interleavedSettle, '--interleaved-settle');
  assignNumberOption(timings, 'pipelineSettleMs', options.pipelineSettle, '--pipeline-settle');
  assignNumberOption(timings, 'finalDrainMs', options.finalDrain, '--final-drain');

  return timings;
}

function assignNumberOption(target, key, value, flagName) {
  if (value === undefined) return;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative number of milliseconds.`);
  }

  target[key] = parsed;
}

function installSignalCleanup() {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping Bluetooth scan/connection...');
    await shutdownBluetooth();
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

function waitForever() {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function writeRawResponses(responses, rawOut) {
  const lines = [
    '# Truma iNet X Live Response Payloads',
    '',
    `Generated: \`${new Date().toISOString()}\``,
    '',
    `Response payloads: ${responses.length}`,
    ''
  ];

  responses.forEach((response, index) => {
    const decoded = decodeFirstCbor(response);
    lines.push(`## Response ${index + 1}`, '');
    lines.push(`- Bytes: ${response.length}`);
    lines.push(`- Hex: \`${response.toString('hex')}\``);
    if (decoded !== null) {
      lines.push('- Decoded CBOR:');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(decoded, jsonReplacer, 2));
      lines.push('```');
    } else {
      lines.push('- Decoded CBOR: `<none>`');
    }
    lines.push('');
  });

  await fs.writeFile(rawOut, lines.join('\n'), 'utf8');
}

function jsonReplacer(_key, value) {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return `0x${Buffer.from(value.data).toString('hex')}`;
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node ./bin/truma-inetx.js scan [--timeout 10000]
  node ./bin/truma-inetx.js pair
  node ./bin/truma-inetx.js connect [--hold] [--no-pair-trigger]
  node ./bin/truma-inetx.js read [--out output/live-settings.md] [--json output/live-settings.json]

Options:
  --name <prefix>       BLE advertised name prefix. Default: Truma iNetX
  --timeout <ms>        Scan timeout. Default: 30000
  --connect-timeout <ms> Single connection attempt timeout. Default: 15000
  --discover-timeout <ms> GATT discovery timeout. Default: 15000
  --connect-retries <n> Connection attempts after discovery. Default: 3
  --warmup-scan <ms>   Scan/log matching advertisements before connecting.
  --scan-service <uuid> Advertised service UUID to scan for. Use "truma" for fc310001. Pair uses this by default.
  --no-service-filter  Scan all BLE advertisements and match by name only. Default.
  --reset-before-connect Reset noble adapter state before connecting.
  --stop-scan-before-connect Use the older scan-stop-connect sequence.
  --debug              Print numbered connection/pairing steps and BLE writes.
  --hold                Keep the BLE connection open for connect command.
  --no-pair-trigger    Connect without subscribing to the protected control characteristic.
  --out <path>          Markdown settings output path.
  --json <path>         JSON settings output path.
  --no-json             Do not write JSON output.
  --raw <path>          Raw response output path. Default: output/live-responses.txt
  --no-raw              Do not write raw response output.
  --no-redact           Include identity-like values in generated output.
  --response-idle <ms>  Wait this long after response data before ACK/flushing. Default: 700
  --interleaved-settle <ms> Wait for an announced response before next payload. Default: 80
  --pipeline-settle <ms> Extra delay after each accepted payload. Default: 0
  --final-drain <ms>    Delay before final response drain. Default: 2500
`);
}
