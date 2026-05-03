# node-red-contrib-truma-inetx

TypeScript BLE library, CLI, and Node-RED nodes for reading and writing Truma
iNet X settings.

The implementation speaks the Truma iNet X application protocol, decodes CBOR
payloads with `cbor-x`, and prints parsed settings as JSON. Bluetooth access is
backend based: `auto` tries BlueZ on Linux and falls back to noble elsewhere,
while `bluez` and `noble` can be selected explicitly.

## Usage

Install dependencies:

```sh
npm install
```

Use Node 20 or 22 LTS for live BLE access. Newer Node releases can work for
tests and builds, but the native noble macOS backend has been less reliable for
Bluetooth connections outside LTS.

Get settings:

```sh
npm run get
```

Use `--debug` for BLE/protocol diagnostics on stderr:

```sh
npm run get -- --debug
```

Select a Bluetooth backend when needed:

```sh
npm run discover -- --bluetooth bluez
npm run get -- --bluetooth noble
```

Pair with the iNet X display while the display is in Bluetooth pairing mode:

```sh
npm run pair
```

On Venus OS / Linux, BlueZ pairing is preferred so bluetoothd owns the
`Device1` object and persists bond keys:

```sh
npm run pair -- --bluetooth bluez --debug
```

Pairing-specific BlueZ controller settings are only applied by `pair`, not by
normal `discover`, `get`, or `set`.

### Headless Venus OS / limited BlueZ shells

Venus OS images may not include `journalctl`, `systemctl`, or `busctl`, and
`bluetoothctl`/`btmon` can be very noisy because other Victron services scan for
BLE devices. A useful first cleanup step is:

```sh
bluetoothctl scan off
bluetoothctl show
```

If `Discovering: yes` returns immediately, another process is restarting BlueZ
discovery. On limited shells, look for likely owners with:

```sh
ps | grep -Ei 'bluetooth|bluez|dbus|venus|victron|ble'
```

For pairing failures, the most useful `btmon` evidence is usually the SMP
pairing/authentication result, not advertisement noise. Replace the address with
the Truma address printed by `npm run pair -- --debug`:

```sh
btmon 2>/dev/null | grep -Ei 'smp|pair|auth|passkey|confirm|encrypt|fail|5A:B0:8D:B0:BC:3A'
```

If the shell has `timeout`, a saved short capture is easier to inspect:

```sh
timeout 30 btmon 2>/dev/null > /tmp/truma-btmon.txt
grep -Ei 'smp|pair|auth|passkey|confirm|encrypt|fail|5A:B0:8D:B0:BC:3A' /tmp/truma-btmon.txt
```

The built-in pairing helper can make this project the default BlueZ agent, but
it cannot forcibly unregister another process' D-Bus agent. If another Venus
service immediately reclaims scanning or pairing behavior, stop/disable that
service temporarily using the tools available on that image, then retry pairing.

Build a reusable settings tree:

```sh
npm run discover > truma-tree.json
```

The tree includes topic group ids, so later reads and writes can target only the
needed device groups:

```sh
npm run get -- Switches
```

Tree topics are grouped by topic name, then parameter name:

```json
{
  "topics": {
    "Switches": {
      "group": "0x0405",
      "parameters": {
        "ExternalLights": {
          "type": 104,
          "available": 1,
          "value": 1
        }
      }
    }
  }
}
```

Set a parameter:

```sh
npm run set -- Switches ExternalLights 1 --tree truma-tree.json
```

The write path initializes the Truma protocol to learn the assigned client
address, then sends a single parameter write. Switch captures use numeric `1`
and `0` values. You can also pass `--group 0405` explicitly instead of `--tree`.

Known working controls and topic mappings are documented in
[docs/control-examples.md](docs/control-examples.md). In particular, room
heating is split across `RoomClimate` and `AirHeating`: use `RoomClimate` for
off/heating/ventilation mode, but use `AirHeating.TgtTemp` for the room heating
target temperature and `AirHeating.Mode` for the heater fan/profile.

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

- `pair()` connects and triggers the operating-system pairing flow.
- `get()` connects, reads, decodes, disconnects, and returns JSON.
- `discover()` builds a reusable settings tree with topic group ids.
- `set()` initializes the protocol, writes one parameter, decodes confirmation
  responses, disconnects, and returns JSON.
- `TrumaProtocol` handles the app-level control/data frame exchange.
- `buildTrumaFrame()`, `buildParameterWriteFrame()`, `decodeTrumaFrame()`, and
  `decodeFirstCbor()` handle Truma frame/CBOR helpers.
- `collectSettings()` and `parseSettingsJson()` normalize topic/parameter
  responses.

## Node-RED

Installing this package into Node-RED registers three nodes:

- `truma-inetx-device`: config node that discovers and caches the iNet X topic
  tree on deploy/start.
- `truma-inetx-get`: gets all settings or multiple selected topics. Incoming
  `msg.payload` may override topics with a string, array, or `{ "topics": [...] }`.
- `truma-inetx-set`: sets one topic/parameter/value. Incoming `msg.payload` may
  override with `{ "topic", "parameter", "value", "group" }`.

The operational nodes serialize BLE access through the shared device node.

## Reverse Engineering

This repo uses macOS PacketLogger captures as the primary source of protocol
truth. Raw captures should be kept local and paired with a short timeline so
the Bluetooth traffic can be matched to app actions.

- Capture workflow: [docs/reverse-engineering/packetlogger-capture.md](docs/reverse-engineering/packetlogger-capture.md)
- Control examples: [docs/control-examples.md](docs/control-examples.md)
- Initial findings: [docs/reverse-engineering/initial-findings.md](docs/reverse-engineering/initial-findings.md)
- Manifest template: [captures/manifest.template.md](captures/manifest.template.md)

Raw `.pklg`, `.pcapng`, capture archives, generated analysis files, build
output, and live output are ignored by git.
