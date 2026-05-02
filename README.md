# node-red-contrib-truma-inetx

TypeScript BLE library and CLI for reading Truma iNet X settings.

The current implementation connects over BLE with `@abandonware/noble`, speaks
the Truma iNet X application protocol, decodes CBOR payloads with `cbor-x`, and
prints parsed settings as JSON.

## Usage

Install dependencies:

```sh
npm install
```

Use Node 20 or 22 LTS for live BLE access. Newer Node releases can work for
tests and builds, but the native noble macOS backend has been less reliable for
Bluetooth connections outside LTS.

Read settings:

```sh
npm run read
```

The CLI writes a single JSON document to stdout. It does not write files.
Generated build output lives in `dist/` and is ignored by git.

## Library

Build the TypeScript library:

```sh
npm run build
```

Run tests:

```sh
npm test
```

Primary exports:

- `readTrumaSettings()` connects, reads, decodes, disconnects, and returns JSON.
- `TrumaProtocol` handles the app-level control/data frame exchange.
- `buildTrumaFrame()`, `decodeTrumaFrame()`, and `decodeFirstCbor()` handle
  Truma frame/CBOR helpers.
- `collectSettings()` and `parseSettingsJson()` normalize topic/parameter
  responses.

## Reverse Engineering

This repo uses macOS PacketLogger captures as the primary source of protocol
truth. Raw captures should be kept local and paired with a short timeline so
the Bluetooth traffic can be matched to app actions.

- Capture workflow: [docs/reverse-engineering/packetlogger-capture.md](docs/reverse-engineering/packetlogger-capture.md)
- Initial findings: [docs/reverse-engineering/initial-findings.md](docs/reverse-engineering/initial-findings.md)
- Manifest template: [captures/manifest.template.md](captures/manifest.template.md)

Raw `.pklg`, `.pcapng`, capture archives, generated analysis files, build
output, and live output are ignored by git.
