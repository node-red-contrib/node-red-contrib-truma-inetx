# node-red-contrib-truma-inetx

Node-RED integration research for Truma iNet X Bluetooth control.

The current focus is reverse engineering the Bluetooth flow used by the
official Truma app, especially the pre-pairing request that causes the iNet X
to initiate normal Bluetooth pairing.

## Reverse Engineering

This repo uses macOS PacketLogger captures as the primary source of protocol
truth. Raw captures should be kept local and paired with a short timeline so
the Bluetooth traffic can be matched to app actions.

- Capture workflow: [docs/reverse-engineering/packetlogger-capture.md](docs/reverse-engineering/packetlogger-capture.md)
- Initial findings: [docs/reverse-engineering/initial-findings.md](docs/reverse-engineering/initial-findings.md)
- Manifest template: [captures/manifest.template.md](captures/manifest.template.md)

Recommended capture package shape:

```text
captures/
  manifest.md
  01_first_pairing.pklg
  02_reconnect_existing_pair.pklg
  03_read_state.pklg
  04_change_temperature.pklg
  05_change_mode.pklg
  06_toggle_each_feature.pklg
  07_notifications_idle.pklg
```

Raw `.pklg`, `.pcapng`, and capture archives are ignored by git by default.
Share them out-of-band or keep them in the local workspace for analysis.

## Node.js BLE Probe

The first live probe is a Node.js CLI that connects to the iNet X from macOS,
triggers pairing by subscribing to the protected control characteristic, and can
read the currently decoded settings into Markdown/JSON.

Install dependencies:

```sh
npm install
```

Use Node 20 or 22 LTS. The macOS native noble backend can scan but fail to
complete connections on newer experimental Node releases.

Trigger pairing/connect:

```sh
npm run pair
```

Before pairing, put the iNet X display into its Bluetooth pairing/search mode.
In PacketLogger captures the display advertised `mfg=730c0001` in that state;
`mfg=730c0000` means it is visible but not pairing-active.
The `pair` command scans for the Truma advertised service UUID by default and
keeps the connection open after subscribing to the protected characteristic.

On the first live run, macOS may ask for Bluetooth permission for the terminal
application that starts Node.js. Allow it, then run the command again if the
first scan times out.

Read all currently decoded parameters:

```sh
npm run read
```

Inspect what macOS/noble currently sees before connecting:

```sh
npm run scan -- --timeout 15000
```

If the iNet X is visible but slow to accept the connection after pairing, give
the probe more attempts:

```sh
npm run read -- --connect-retries 5 --connect-timeout 25000
```

If the display is advertising but connection attempts still time out, try the
more cautious CoreBluetooth path:

```sh
npm run read -- --warmup-scan 5000 --connect-retries 5 --connect-timeout 25000
```

If noble sees the display but stays stuck in `state=connecting`, bypass noble
entirely with the native macOS CoreBluetooth probe:

```sh
npm run macos:pair
```

This command scans for the Truma advertised service, opens a CoreBluetooth
connection, discovers GATT services, reads the software revision, and subscribes
to the Truma control characteristic. The important lines are:

```text
[swift-pair] connected: ...
[swift-pair] subscribing to Truma control characteristic; this should trigger pairing if protected
```

If this reaches `connected`, the problem is in the Node/noble connection layer.
If it also hangs before `connected`, capture this failing run with PacketLogger
so it can be compared directly against the successful official app trace.

For the current stuck-before-connect case, try the closest native variants:

```sh
npm run macos:hold
npm run macos:pair -- --no-service-filter --require-pairing-state --keep-scanning --timeout 120
npm run macos:pair -- --no-service-filter --keep-scanning --timeout 90
npm run macos:pair -- --no-service-filter --keep-scanning --no-connect-options --timeout 90
```

`macos:hold` is only a fallback diagnostic bridge. The normal path is now
`npm run read`; use `macos:hold` only when you need to compare CoreBluetooth
connection behavior against noble.

The probe prints `still waiting for didConnect` every three seconds while
CoreBluetooth is waiting for the link to complete. The
`--require-pairing-state` variant waits for the Truma manufacturer data to
change from `mfg=730c0000` (`normal-or-inactive`) to `mfg=730c0001`
(`pairing-or-ble-active`) before attempting the connection.

The probe connects directly from the scan callback by default, which is closer
to how phone apps usually use CoreBluetooth. To compare against the older
scan-stop-connect path:

```sh
npm run read -- --stop-scan-before-connect --warmup-scan 5000 --connect-retries 5 --connect-timeout 25000
```

If you explicitly want to scan only for the Truma advertised service UUID:

```sh
npm run scan -- --scan-service truma --timeout 15000
```

Default outputs:

```text
output/live-settings.md
output/live-settings.json
output/live-responses.txt
```

Generated live outputs are ignored by git because they can contain local device
identity values.
