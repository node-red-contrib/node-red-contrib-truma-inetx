# Control Examples

This file documents the topic/parameter mappings that have been verified
against PacketLogger captures and live device tests. Use `npm run discover >
truma-tree.json` first, then prefer `--tree truma-tree.json` so the CLI can
infer the correct device group for each topic.

## Room Heating

Room heating is split across `RoomClimate` and `AirHeating`.

Use `RoomClimate` for the high-level climate state:

- `RoomClimate.Mode` selects off, heating, or ventilation.
- `RoomClimate.Active` reports the high-level active state.
- `RoomClimate.TgtTemp` exists in the tree, but did not control the room
  heating target in the tested captures. Treat it as informational/unused until
  a capture proves otherwise.

Use `AirHeating` for the heater-specific controls:

- `AirHeating.TgtTemp` controls the room heating target temperature.
- `AirHeating.Mode` controls the air-heater mode/fan profile.
- `AirHeating.Temp` is the measured air-heater temperature and should be read,
  not written.

Temperature values use tenths of a degree Celsius:

| UI value | Protocol value |
| --- | ---: |
| 5.0°C | `50` |
| 10.0°C | `100` |
| 15.0°C | `150` |
| 22.0°C | `220` |

Examples:

```sh
npm run set -- --tree truma-tree.json --topic RoomClimate --param Mode --value 3
npm run set -- --tree truma-tree.json --topic RoomClimate --param Mode --value 5
npm run set -- --tree truma-tree.json --topic RoomClimate --param Mode --value 0
npm run set -- --tree truma-tree.json --topic AirHeating --param TgtTemp --value 220
npm run set -- --tree truma-tree.json --topic AirHeating --param Mode --value 1
```

Known `RoomClimate.Mode` values from the discovered tree:

| Name | Value |
| --- | ---: |
| Off | `0` |
| Heating | `3` |
| Ventilating | `5` |

Known `AirHeating.Mode` values from the discovered tree:

| Name | Value |
| --- | ---: |
| Fast | `0` |
| Comfort | `1` |

## Water Heating

Water heating worked with the generic parameter write path.

Use `WaterHeating.Mode` to select the target water temperature. The discovered
tree currently exposes these values:

| Name | Value |
| --- | ---: |
| 40 | `0` |
| 60 | `1` |
| 70 | `2` |

Examples:

```sh
npm run set -- --tree truma-tree.json --topic WaterHeating --param Mode --value 0
npm run set -- --tree truma-tree.json --topic WaterHeating --param Mode --value 1
npm run set -- --tree truma-tree.json --topic WaterHeating --param Mode --value 2
```

`WaterHeating.Temp` is the measured water temperature and should be read, not
written.

## Switches

Switches worked with the generic parameter write path. Switch values use `1`
for on and `0` for off.

Examples:

```sh
npm run set -- --tree truma-tree.json --topic Switches --param ExternalLights --value 1
npm run set -- --tree truma-tree.json --topic Switches --param ExternalLights --value 0
npm run set -- --tree truma-tree.json --topic Switches --param InternalLights --value 1
npm run set -- --tree truma-tree.json --topic Switches --param InternalLights --value 0
```

## Implementation Notes

All verified writes use the same application frame shape:

```js
{ tn: '<TopicName>', pn: '<ParameterName>', v: <value> }
```

The target group comes from the discovered tree. For the tested installation:

| Topic | Group |
| --- | --- |
| `RoomClimate` | `0x0101` |
| `AirHeating` | `0x0201` |
| `WaterHeating` | `0x0201` |
| `Switches` | `0x0405` |
