# node-red-contrib-truma-inetx

TypeScript BLE library and CLI for reading and writing Truma iNet X settings.

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

On Venus OS / Linux after pairing with `pair --bluez`, read through BlueZ so
bluetoothd resolves the Truma identity and uses the persisted bond keys:

```sh
npm run discover -- --bluez
npm run read -- --bluez
```

Pair with the iNet X display:

```sh
npm run pair
```

Run `pair` while the iNet X display is in Bluetooth pairing mode. The command
connects, subscribes to the protected Truma control characteristic to trigger
the normal operating-system pairing flow, then keeps the BLE connection open briefly so the
OS can finish pairing. If you need more time for the pairing prompt, use:

```sh
npm run pair -- --hold-ms 30000
```

On headless Linux/BlueZ, there is no GUI prompt. `npm run pair` starts a quiet
private `bluetoothctl` pairing agent automatically, using `NoInputNoOutput` by
default. That keeps the noisy scanner/device output out of your terminal while
still giving BlueZ an agent that can accept Just Works pairing.

On Venus OS / Linux, prefer pairing through bluetoothd D-Bus so BlueZ owns the
`Device1` object and can persist the bond keys:

```sh
npm run pair -- --bluez --legacy-pairing --agent-capability NoInputNoOutput --hold-ms 30000
```

The older default pairing path still uses noble to trigger the protected Truma
subscription directly. That can complete SMP encryption in-memory, but on Venus
OS it may not create a persistent folder under `/data/var/lib/bluetooth/...`,
which causes later reads to reconnect without encryption.

If your device requires a different agent capability:

```sh
npm run pair -- --agent-capability KeyboardDisplay
```

If `btmon` shows SMP `Confirm value failed` and the Truma pairing request is
legacy while BlueZ responds with Secure Connections, try the opt-in legacy mode:

```sh
npm run pair -- --legacy-pairing --hold-ms 30000
```

On Linux this temporarily runs `btmgmt sc off` before pairing, tries
`btmgmt io-cap 3` so the controller behaves as `NoInputNoOutput`, and restores
Secure Connections afterwards when it was previously enabled. On limited Venus
OS shells the command also falls back to interactive `btmgmt` mode, matching:

```sh
btmgmt
sc off
io-cap 3
```

If `btmon` still shows `SC` in the SMP pairing response, power-cycle the
controller while applying the setting:

```sh
npm run pair -- --legacy-pairing --legacy-power-cycle --hold-ms 30000
```

This temporarily runs `btmgmt power off`, applies the legacy pairing settings,
then powers the controller back on before connecting.

If the controller settings include `privacy` and legacy pairing still fails at
`SMP: Pairing Confirm`, try disabling controller privacy during pairing too:

```sh
npm run pair -- --legacy-pairing --disable-privacy --hold-ms 30000
```

For the strongest Venus OS attempt:

```sh
npm run pair -- --legacy-pairing --legacy-power-cycle --disable-privacy --agent-capability NoInputNoOutput --hold-ms 30000
```

Once the iNet X is paired on Venus OS, persist the controller settings that
proved necessary for legacy Truma pairing:

```sh
npm run victron
```

This applies the persistent sequence:

```sh
btmgmt power off
btmgmt sc off
btmgmt io-cap 3
btmgmt power on
```

It intentionally does not restore Secure Connections afterwards. This is a
pairing/controller preparation command, not part of normal `discover` or `read`.

If you want to manage the BlueZ agent manually, disable the built-in helper:

```sh
npm run pair -- --no-linux-agent
```

Manual agent setup is still possible in another shell:

```sh
bluetoothctl
power on
agent NoInputNoOutput
default-agent
```

Leave that `bluetoothctl` session open, put the iNet X display into Bluetooth
pairing mode, then run `TRUMA_DEBUG=1 npm run pair -- --no-linux-agent` in
another shell.

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
the Truma address printed by `TRUMA_DEBUG=1 npm run pair`:

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

If the filtered `btmon` output includes:

```text
SMP: Pairing Failed
Reason: Confirm value failed
```

and the pairing response advertises `SC` while the Truma request does not, retry
with `--legacy-pairing`.

Build a reusable settings tree:

```sh
npm run discover > truma-tree.json
```

The tree includes topic group ids, so later reads and writes can target only the
needed device groups:

```sh
npm run read -- --tree truma-tree.json --topic Switches
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
npm run set -- --tree truma-tree.json --topic Switches --param ExternalLights --value 1
```

The write path initializes the Truma protocol to learn the assigned client
address, then sends a single parameter write. Switch captures use numeric `1`
and `0` values. You can also pass `--group 0405` explicitly instead of
`--tree`.

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

- `pairTruma()` connects and triggers the operating-system pairing flow.
- `readTrumaSettings()` connects, reads, decodes, disconnects, and returns JSON.
- `discoverTrumaTopology()` builds a reusable settings tree with topic group ids.
- `setTrumaParameter()` initializes the protocol, writes one parameter, decodes the
  confirmation responses, disconnects, and returns JSON.
- `TrumaProtocol` handles the app-level control/data frame exchange.
- `buildTrumaFrame()`, `buildParameterWriteFrame()`, `decodeTrumaFrame()`, and
  `decodeFirstCbor()` handle Truma frame/CBOR helpers.
- `collectSettings()` and `parseSettingsJson()` normalize topic/parameter
  responses.

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
