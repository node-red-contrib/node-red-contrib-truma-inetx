# Truma temperatures as Victron virtual sensors

Import [the example flow](../examples/victron-temperatures.json) into Node-RED on
Venus OS. It requires this package and the official
[`@victronenergy/node-red-contrib-victron` virtual-device node](https://github.com/victronenergy/node-red-contrib-victron/blob/master/docs/USER_GUIDE.md#virtual-devices)
with the Temperature sensor type, `start_disconnected`, and `msg.connected`
presence control. If your installed Victron nodes do not expose these features,
update through the supported Venus OS path before using the example.

1. Open the Truma device config, select the adapter and panel, and pair if needed.
2. Confirm that fresh reads contain `AirHeating.Temp` and `WaterHeating.Temp`.
   Adjust the converter if your panel uses other measured-temperature topics.
3. Keep the two virtual nodes as Temperature sensors, with **Room (3)** and
   **Water heater (5)** respectively. Demo/default values are disabled and both
   sensors start disconnected.
4. Deploy and click the poll Inject button. The default interval is 120 seconds
   to leave gaps for the phone app. Pause the poller while using the phone for
   longer sessions. The gate skips overlapping reads rather than building a queue.
5. Check the two sensors in the GX device list. Verify their values against the
   panel before relying on downstream automations.

The converter reads **fresh get-node output**, divides Truma's raw tenths of a
°C by 10, and sends `/Temperature` and `/Status` to the virtual nodes. Presence
changes are separate messages because a message with `connected` is handled as
a presence command by the official node. Zero is a valid reading. Missing,
unavailable, nonnumeric, or out-of-range values disconnect that sensor; the
example accepts −50 to 150 °C to exclude common sentinel values. Adapt those
bounds only if your sensor requires it.

A Catch node disconnects both sensors on read failure. An independent 30-second
check disconnects readings that are at least five minutes old. Missing values
are never replaced with zero, and discovery-cache values do not refresh their
age. A valid later reading restores the sensor. These conversion and freshness
rules are covered by automated tests; live GX/D6E testing is still required.

If another flow already polls Truma, remove the example's poll/read/gate nodes
and connect that flow's **raw fresh results** to the converter. Do not divide
values that have already been normalized to °C by a dashboard flow.

This can replace the temperature-mirroring part of Mathieu's optional Python
service. It does not replace his settings bridge, dashboard, or custom QML
page. The official nodes choose their own D-Bus service names and device
instances; consumers using fixed `temperature.trumaroom` or
`temperature.trumaboiler` names must be updated. Avoid running both sets of
sensors concurrently after migration. The discussion is in
[Mathieu's issue #6](https://github.com/Mathieu0994/Victron-x-Truma-Integration-/issues/6).
