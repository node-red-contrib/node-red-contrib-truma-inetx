# Implementation comparison and remaining hardware checks

The implementations were developed independently. This comparison uses
[`daaaaan/truma-inetx-ble` at 719ae79](https://github.com/daaaaan/truma-inetx-ble/tree/719ae7939db97e18f15e45ec774b6453148ab646)
and
[Mathieu's integration at 8d8717b](https://github.com/Mathieu0994/Victron-x-Truma-Integration-/tree/8d8717b0c340fdbdb21d997ed4e8309569aade53).
These are code observations, not comparative hardware-test results.

| Area | Adopted here / decision |
| --- | --- |
| Bluetooth adapter | Select by stable MAC, hci name, or object path in the config node and CLI. Discovery, pairing and sessions stay on that adapter, removing the need for Mathieu's distribution-file adapter patch. |
| Pairing | Offer a BlueZ agent and transient six-digit code in the device editor, with device-scoped authorization and no saved passkey. Keep CLI controller preparation available for panels needing it. |
| Time | Send the applicable UTC offset instead of either a fixed 720 or zero. Use an optional IANA timezone and calculate DST on every request. The decompiled official-app excerpt supplied in the discussion supports interpreting Lot as the offset in minutes. |
| Writes | Match target group, topic, parameter and value before reporting confirmation. Validate available range/enum metadata and never automatically repeat an uncertain write. |
| BLE lifetime | Retain operation-scoped sessions. A persistent service connection would prevent the phone from connecting between operations on panels supporting only one connection. |
| Victron temperature services | Provide a flow using official virtual sensors. This avoids a separate Python process for temperature mirroring while leaving dashboard/QML integration independent. |
| Installation | Make noble optional so BlueZ-only installs can omit native backend build dependencies. |

## Persistent client identity

The Python service persists a client identity and sends `MobileIdentity.UserName`,
`Muid`, and `Uuid` during initialization. This is distinct from the dynamically
assigned Truma protocol address, which this library already learns per session,
and from the Bluetooth bond maintained by BlueZ.

We have not established whether persistent identity is necessary, harmless, or
panel/firmware-dependent for this library's short sessions. Normal reads and
writes therefore retain the existing handshake; this change does not silently
create or overwrite a mobile identity on the panel.

Before adding it, capture and compare sessions with and without identity writes:

- First connection, reconnect, process restart, and host reboot.
- Existing phone bond and phone access after each library disconnect.
- Device-list entries and identity stability, avoiding duplicate mobile entries.
- Read/write confirmation behavior on each panel/firmware under test.

Only introduce persisted identity once these observations establish the required
sequence and lifetime. Do not copy another installation's UUID or bond material.

## Live validation before release

- Test internal and USB adapters, including hci renumbering and an unavailable
  selected adapter. Check discovery, pairing, reads and writes on the same radio.
- Pair from the editor with and without a code, including leading zeroes, wrong
  code, cancellation/timeout, and reconnect after restarting Node-RED.
- Check confirmed values and a deliberately interrupted confirmation. Confirm
  the caller sees uncertainty and the write is not repeated automatically.
- Verify Berlin and Auckland offsets against the panel/app behavior. The wire
  value is covered by tests; its visible effect on panel time remains unverified.
- Exercise the temperature flow on GX, including heater offline, partial reads,
  five-minute expiry, recovery and phone usage between polls.

Coordinate released-version tests with Mathieu in
[issue #5](https://github.com/Mathieu0994/Victron-x-Truma-Integration-/issues/5).
