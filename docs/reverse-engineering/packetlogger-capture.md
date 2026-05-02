# macOS PacketLogger Capture Workflow

Use Apple PacketLogger as the only capture path for Truma iNet X Bluetooth
reverse engineering. The most useful artifact is the original `.pklg` file
plus a short action timeline, because PacketLogger preserves HCI direction,
timestamps, pairing events, GATT traffic, and payload bytes.

## Setup

1. Install PacketLogger from Apple's "Additional Tools for Xcode".
2. Open PacketLogger and start a Bluetooth capture before opening the Truma
   app or touching the iNet X.
3. Keep each capture short and focused on one behavior.
4. Stop the capture immediately after the behavior is complete.
5. Save the raw file as `.pklg`.

For first-pairing captures, start from a clean state:

- Forget or remove the iNet X pairing on macOS.
- Quit and reopen the Truma app.
- Start PacketLogger before opening the app.

## Export Format

Primary export:

- Raw PacketLogger `.pklg` files.
- A `manifest.md` timeline file based on
  [`captures/manifest.template.md`](../../captures/manifest.template.md).

Optional export:

- Open the `.pklg` in Wireshark and save a `.pcapng` copy.

Avoid exporting screenshots, full system diagnostics, or unrelated logs unless
they explain a specific command or value. Bluetooth captures can contain device
identifiers, so do not commit raw captures unless that is intentional.

## Capture Matrix

Use these filenames for consistency:

| File | Scenario |
| --- | --- |
| `01_first_pairing.pklg` | Unpaired iNet X, start app, trigger the special request, accept pairing. |
| `02_reconnect_existing_pair.pklg` | Already paired, app reconnects normally. |
| `03_read_state.pklg` | App opens and reads current device state. |
| `04_change_temperature.pklg` | Change only the temperature once. |
| `05_change_mode.pklg` | Change only one mode setting. |
| `06_toggle_each_feature.pklg` | One capture per toggle, if possible. |
| `07_notifications_idle.pklg` | Leave app connected for 1-2 minutes without touching controls. |

If a scenario needs repeated values, create separate captures with explicit
names such as `04_change_temperature_18_to_20.pklg` and
`04_change_temperature_20_to_22.pklg`.

## Manifest Rules

For each capture, record exact times and actions:

- Device context: Mac model, macOS version, Truma app version, visible iNet X
  firmware or version.
- Timeline: start capture, app launch, tap/action, pairing popup, value change,
  connected state, stop capture.
- Expected important behavior: what the capture should prove.

Example:

```md
# 01_first_pairing.pklg

Device:
- Mac model:
- macOS version:
- Truma app version:
- iNet X firmware/version if visible:

Timeline:
- 12:03:00 Started PacketLogger capture
- 12:03:10 Opened Truma app
- 12:03:18 Tapped iNet X device
- 12:03:22 Pairing popup appeared
- 12:03:26 Accepted pairing
- 12:03:40 App showed connected
- 12:03:50 Stopped capture

Expected important behavior:
- This capture should contain the special pre-pairing request.
```

## Analysis Workflow

When captures are available, inspect `.pklg` or `.pcapng` files for:

- Advertising and device identity behavior.
- Service discovery, characteristic UUIDs, and ATT handles.
- ATT reads, writes, write-with-response, write-without-response, indications,
  and notifications.
- Security Manager pairing events and timing around the pre-pairing request.
- Payload differences between one-action captures.

The first implementation target after analysis is a minimal Node.js BLE probe
that can reproduce discovery, connection, pairing trigger, reads, writes, and
notifications before the behavior is wrapped as Node-RED nodes.
