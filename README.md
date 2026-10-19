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

## Related projects

### Python / Home Assistant alternative

[daaaaan/truma-inetx-ble](https://github.com/daaaaan/truma-inetx-ble) is an
alternative Python implementation with Home Assistant integration, MQTT, and a
standalone service for Victron Cerbo GX / Venus OS. It may be a useful option if
you prefer a Home Assistant / Python solution to a Node-RED integration.

The two projects were developed independently. We discovered that project by
chance after developing this implementation; its development started earlier.
Sharing protocol findings and interoperability experiences could help both
projects support more Truma setups.

### Victron dashboards and GX Touch integration

[Mathieu0994/Victron-x-Truma-Integration-](https://github.com/Mathieu0994/Victron-x-Truma-Integration-)
uses this package for BLE communication and adds a Node-RED Dashboard 2 UI
accessible through VRM, a D-Bus bridge, and a custom GX Touch page for controlling
a Truma D6E from a Victron GX device. It is a complementary project for users
looking for a ready-made Venus OS interface built on this library. See its
README for tested hardware, firmware versions, and deployment limitations.

## Usage

Install dependencies:

```sh
npm install
```

For Linux / Venus OS using BlueZ only, `npm install --omit=optional` skips the
native noble backend and its build dependencies. The BlueZ path needs Node.js,
the running system Bluetooth service, and D-Bus access; no Python service is
needed. Noble remains available as an optional backend for other platforms.

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

Open the `truma-inetx-device` configuration, select the adapter, click **Search**,
and select your panel. Put the panel in Bluetooth pairing mode and click **Pair**.
Confirm on the panel if requested. Pairing uses the current
editor selection, so it can run before deployment. Deploy afterwards and use
**Reread** to refresh topic names and the device list. Use a Get node to read
parameter values; it learns missing topic groups within that same connection.

Deleting a Node-RED device configuration does not delete the Linux Bluetooth
bond. To reset it, select an explicit adapter and device and click **Forget
pairing**. This immediately removes that host bond and cached device, affecting
all flows using the same device on that adapter. It does not remove your phone's
pairing. You may also need to remove this host on the Truma panel. Search again,
select the panel's current entry, and pair again.

The search list can include cached devices. **Paired on host** describes Linux's
stored bond, which can remain after deleting pairing on the panel. A stale public
identity address and a new unpaired random address may therefore appear with the
same name; the name alone does not prove they are the same physical device.

The **Connection** dropdown defaults to **Close after every request**, so the
phone can connect between requests. Alternatively, choose **Keep open until idle
timeout (experimental)** and set the number of minutes (default 1). Requests reuse the connection
and reset the idle timer. Failed requests, redeployment, and editor Bluetooth
operations or requests for another device close it immediately. The phone app
can connect after the connection closes. The timeout counts from request completion.
Some panels or Bluetooth adapters may drop a retained connection before the idle
timeout. Use close-after-request mode if repeated reads become unreliable.
Pair first: reading an unpaired BlueZ device reports an error instead of opening
a connection that waits for pairing.

Editor pairing requires BlueZ on Linux and permission for the Node-RED process
to use the system Bluetooth D-Bus API. It does not change controller-wide
settings. Panels requiring the older controller preparation can still use the
CLI pairing path. Pairing and adapter changes need validation on your actual
panel/firmware; automated tests use simulated devices.

The **Adapter** dropdown lists detected hardware as `hci0 (MAC address)` and stores
the MAC address, which stays stable across hci renumbering. **Automatic** lets the
backend choose. A saved adapter that is absent remains visible as unavailable.
The CLI also accepts `hci0` / `hci1` or a BlueZ object path. The same adapter is used for
discovery, pairing, reading and writing. An explicit missing adapter fails
instead of silently choosing another. With an adapter selected, `auto` uses
BlueZ; explicit `noble` requires leaving the adapter blank.

CLI equivalents:

```sh
npm run get -- --adapter hci1 --device-address AA:BB:CC:DD:EE:FF
npm run pair -- --bluetooth bluez --adapter hci1 --device-address AA:BB:CC:DD:EE:FF --passkey 001234
```

A CLI passkey may be saved by shell history. Panels requiring a code can use the
CLI's `--passkey` option; the editor has no code field.

### Local time

`SystemTime.Time` remains Unix time in UTC. `SystemTime.Lot` now carries the local
UTC offset in minutes, including daylight saving time (for example, Germany
60/120, Auckland 720/780). It defaults to the Node-RED/CLI host timezone.
In the device editor, leave Timezone blank (or click **Automatic (host)**) to use
the computer running Node-RED. The editor shows the detected host timezone and
offers timezone suggestions as you type. **Use browser timezone** copies the
timezone of the computer or phone opening the editor into the configuration;
it stays selected until you change it. This does not change the host OS timezone.
Override it with an IANA timezone in the device configuration, via CLI
`--time-zone Europe/Berlin`, or library `protocol: { timeZone: 'Europe/Berlin' }`.
This is useful when the GX host runs in UTC; travelling users should update the
configured timezone when necessary.

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

A successful `set()` result includes `write.status: "confirmed"` only after the
target group reports the requested topic, parameter and value. A timeout raises
`WriteUnconfirmedError` (`code: "TRUMA_WRITE_UNCONFIRMED"`): the write may have
succeeded, so read it back before retrying. Writes are never automatically
repeated, including when callers supply the legacy `readRetries` option. In
Node-RED, unconfirmed writes use a yellow status and go to the Catch node without
emitting a successful result.

The set node validates values against cached parameter metadata (availability,
numeric bounds and available enum choices). CLI `--tree` provides the same
checks, and library callers can pass `metadata`. Without metadata, only basic
value checks apply; no ranges or permission-bit meanings are guessed. Values
remain in protocol units, such as tenths of a degree Celsius. Read the affected
topic again when the panel configuration changes.

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

- `truma-inetx-device`: config node that discovers topic names and the device
  list on deploy/start, without querying every device group's parameters.
- `truma-inetx-get`: gets all settings or multiple selected topics. Incoming
  `msg.payload` may override topics with a string, array, or `{ "topics": [...] }`.
- `truma-inetx-set`: sets one topic/parameter/value. Incoming `msg.payload` may
  override with `{ "topic", "parameter", "value", "group" }`. If the topic's
  group is unknown, it first reads that topic to learn its group and metadata.

The operational nodes and editor discovery/pairing actions serialize BLE access
across all Truma device nodes in this Node-RED process. Each operation disconnects
when finished. This does not coordinate with separate CLI processes; avoid
running them during Node-RED polling.

For room and boiler sensors on Venus OS, import
[examples/victron-temperatures.json](examples/victron-temperatures.json). It uses
the official Victron virtual-device nodes, converts raw temperature units once,
and disconnects missing or stale sensors. See
[the setup guide](docs/victron-temperatures.md).
