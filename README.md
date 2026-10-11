# node-red-contrib-truma-inetx

TypeScript BLE library, CLI, and Node-RED nodes for reading and writing Truma
iNet X settings.

The implementation speaks the Truma iNet X application protocol, decodes CBOR
payloads with `cbor-x`, and prints parsed settings as JSON. Bluetooth access is
backend based: `auto` tries BlueZ on Linux and falls back to noble elsewhere,
while `bluez` and `noble` can be selected explicitly.

The connection is intentionally released after each read, discovery, or write
operation. This leaves the panel available for the Truma phone app between
Node-RED operations, instead of occupying its Bluetooth connection continuously.
Allow time between polling requests so the phone app can connect.

## Related project

[daaaaan/truma-inetx-ble](https://github.com/daaaaan/truma-inetx-ble) is an
alternative Python implementation with Home Assistant integration, MQTT, and a
standalone service for Victron Cerbo GX / Venus OS. It may be a useful option if
you prefer a Home Assistant / Python solution to a Node-RED integration.

The two projects were developed independently. We discovered that project by
chance after developing this implementation; its development started earlier.
Sharing protocol findings and interoperability experiences could help both
projects support more Truma setups.

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

### Headless Venus OS / Victron

Pairing on a Victron Ekrano or GX device currently needs to be done from the
command line. Pairing from the Node-RED device configuration is planned; see
the TODO list below.

### Initial Build of Settings Tree

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

## TODO

- [ ] Add Bluetooth adapter selection (for example, `hci0` or `hci1`) to the
  `truma-inetx-device` configuration and use it consistently for discovery,
  pairing, reads, and writes.
- [ ] Investigate and add pairing directly from the `truma-inetx-device`
  configuration, including entry of the code shown on the panel where required,
  so end users do not need the command line.
- [ ] Calculate `SystemTime.Lot` from the applicable local UTC offset, including
  daylight saving time, instead of sending a fixed value.
- [ ] Distinguish confirmed parameter writes from requests sent without a
  matching confirmation.
- [ ] Validate writes against discovered parameter metadata, including ranges
  and enum values.
- [ ] Compare protocol findings with
  [daaaaan/truma-inetx-ble](https://github.com/daaaaan/truma-inetx-ble), including
  persistent client identity and compatibility across panels and firmware.
  Keep releasing the connection after each operation so the phone app can
  continue to connect between operations.
