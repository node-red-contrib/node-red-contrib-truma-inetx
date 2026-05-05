# Initial PacketLogger Findings

These findings are derived from local `.pklg` captures.

## Device Identity

- Advertised name: `Truma iNetX-ZZZZZZ`.
- BLE address observed in the pairing capture: `ZZ:ZZ:ZZ:ZZ:ZZ:ZZ`.
- Advertising manufacturer data observed before pairing:
  - `mfg=0x0c73:00 00` during the earlier baseline period.
  - `mfg=0x0c73:00 01` around the later pairing period.
- Advertising also includes service UUID data:
  - `d1 9f 1b 1f 80 f2 b2 8e e8 11 b2 f3 01 00 31 fc`
  - Interpreted as UUID `fc310001-f3b2-11e8-8eb2-f2801f1b9fd1` in BLE little-endian byte order.

## Pairing Trigger

The likely app-side pairing trigger is not a proprietary payload. It is a
standard ATT write that tries to enable notifications on a protected Truma
characteristic:

1. App connects to the iNet X.
2. App performs GATT discovery.
3. App reads handle `0x0019` and receives ASCII `5.1`.
4. App writes `01 00` to handle `0x0023`.
5. iNet X responds with ATT Error Response:
   - request opcode: `0x12` (`Write Request`)
   - handle: `0x0023`
   - error: `0x05` (`Insufficient Authentication`)
6. SMP pairing starts immediately after that error.

Implementation implication: a probe should reproduce discovery, then attempt to
write `01 00` to descriptor handle `0x0023`. The OS/BLE stack should then
surface the normal pairing flow.

The TypeScript CLI exposes this as:

```sh
npm run pair
npm run pair -- --debug
```

Run it while the iNet X display is in Bluetooth pairing mode. The command keeps
the connection open briefly after the protected subscribe so the operating
system can finish pairing.

### Venus OS / Victron BlueZ

On Venus OS, the iNet X may pair successfully but later sessions can still look
like a BLE-level connection only: GATT connects, but the display does not switch
to the active app connection icon and protocol subscription/read can stall.

The working mitigation was to apply controller settings for Truma's legacy LE
pairing behavior during BlueZ pairing:

```sh
power off
sc off
io-cap 3
power on
```

Current CLI pairing keeps those details internal and only exposes backend
selection:

```sh
npm run pair -- --bluetooth bluez --debug
```

Pairing/controller preparation is not part of normal `discover`, `get`, or
`set`.

Later Venus testing showed a more important distinction: noble-triggered pairing
can complete SMP encryption and key exchange in `btmon`, but bluetoothd may not
create a persistent Truma device folder under
`/data/var/lib/bluetooth/<adapter>/<device>/info`. Later reconnects then fail
the protected CCCD write with `Insufficient Encryption (0x0f)`.

The Linux pairing path should therefore use BlueZ D-Bus:

```sh
npm run pair -- --bluetooth bluez --debug
```

The goal is to make bluetoothd own the `org.bluez.Device1` object and persist
the bond keys before normal protocol reads/writes.

## GATT Shape

Observed Truma primary service:

- Handle range: `0x0020` through end of table.
- Service UUID bytes from ATT response:
  - `d1 9f 1b 1f 80 f2 b2 8e e8 11 b2 f3 00 40 31 fc`
  - Interpreted UUID: `fc314000-f3b2-11e8-8eb2-f2801f1b9fd1`.

Observed characteristics under the Truma service:

| Declaration | Value | Properties | UUID |
| ---: | ---: | ---: | --- |
| `0x0021` | `0x0022` | `0x18` | `fc314001-f3b2-11e8-8eb2-f2801f1b9fd1` |
| `0x0024` | `0x0025` | `0x04` | `fc314002-f3b2-11e8-8eb2-f2801f1b9fd1` |
| `0x0026` | `0x0027` | `0x10` | `fc314003-f3b2-11e8-8eb2-f2801f1b9fd1` |
| `0x0029` | `0x002a` | `0x10` | `fc314004-f3b2-11e8-8eb2-f2801f1b9fd1` |

Observed CCCD descriptors:

- `0x0023`, descriptor UUID `0x2902`
- `0x0028`, descriptor UUID `0x2902`
- `0x002b`, descriptor UUID `0x2902`

## Connected Protocol

The connected app trace shows this working pattern:

- ATT connection handle: `0x004c`.
- MTU exchange: app asks for `527`, device responds with `251`.
- App enables notifications by writing `01 00` to:
  - `0x0023`
  - `0x0028`
- App writes small control/request frames to `0x0022`.
- App writes larger data frames to `0x0025` using Write Command.
- iNet X sends status notifications on `0x0022`.
- iNet X sends response data notifications on `0x0027`.

### Client Address

The protocol/version response assigns the live client address for the current
connection. Later app-layer frames must use that address; the address from one
capture must not be hardcoded into another run.

Observed behavior:

- The protocol-version request uses broadcast/source placeholder addressing.
- The response contains CBOR data with keys like `pv` and `addr`.
- Topic and read frames sent after this response use the assigned client address
  in their frame header.
- If later frames use a stale client address from a previous capture, the BLE
  transport can still acknowledge the write with `f0 01`, but the application
  layer does not return topic or setting data.

Implementation implication: parse `addr` from the protocol-version response and
rewrite every later frame that has a client/source address field. This was the
first live milestone that made the Node.js probe read data successfully.

### Parameter Writes

1. Write a control announce to the control characteristic:
   `01 <payload-length-le16>`.
2. Wait for control notification `81 00`.
3. Write one Truma data frame to the write characteristic.
4. Wait for `f0 01` or response progress.
5. Request pending response payloads with `03 00` and acknowledge them with
   `f0 01`.

The data frame is a normal Truma frame addressed to the topic's device group.
The source/client address must be the assigned client address learned from the
protocol-version response. The operation is `0x0003`, flags are `0x0001`, and
the CBOR body is a single parameter object:

```js
{ tn: 'Switches', pn: 'ExternalLights', v: 1 }
```

Captured switch examples:

| Action | Target group | Topic | Parameter | Value |
| --- | --- | --- | --- | --- |
| External lights on | `0x0405` | `Switches` | `ExternalLights` | `1` |
| External lights off | `0x0405` | `Switches` | `ExternalLights` | `0` |
| Internal lights on | `0x0405` | `Switches` | `InternalLights` | `1` |
| Internal lights off | `0x0405` | `Switches` | `InternalLights` | `0` |

The capture also includes `PowerMgmt.PwrMode` writes to group `0x0101` using
the same `{ tn, pn, v }` body. This strongly suggests temperature, energy
source, and other writable settings use the same generic parameter-write shape;
what changes is the target group, parameter name, and value encoding.

- `Switches` and `WaterHeating` work with the generic parameter-write path.
- Room heating is split across multiple topics:
  - `RoomClimate` controls the high-level off/heating/ventilation mode.
  - `RoomClimate.TgtTemp` is present, but did not control the heater target in
    the tested capture.
  - `AirHeating.TgtTemp` controls the room heating target temperature.
  - `AirHeating.Mode` controls the air-heater mode/fan profile.
- Temperature values with type `10` are tenths of a degree Celsius. For
  example, the app writes `AirHeating.TgtTemp = 50`, `100`, and `150` for
  5°C, 10°C, and 15°C.

See [../control-examples.md](../control-examples.md) for user-facing commands
and known-good mappings.

### Discovery Order

The iNet X platform is modular, so a client should not assume a fixed installed
device list. A robust read flow is:

1. Request protocol version and learn the assigned client address.
2. Request top-level topic lists.
3. Request the device list.
4. Decode the `Devices` array from the response.
5. Read each detected device group dynamically.

This matches the platform model where heater, air-conditioning, panel, BLE
management, tanks, and other modules may appear or disappear depending on the
installation.

The app-level payload after the binary frame header is CBOR. The TypeScript
library decodes it with `cbor-x`. Examples from the connected trace include:

- Protocol/version request: `{'pv': [5, 1]}`
- Topic-list request/response containing:
  - `AirCirculation`, `AirCooling`, `AirHeating`, `DeviceManagement`,
    `EnergySrc`, `ErrorReset`, `FreshWater`, `GasBtl`, `GasControl`,
    `GreyWater`
  - `Identify`, `L1Bat`, `L2Bat`, `LinePower`, `MobileIdentity`,
    `PowerSupply`, `RoomClimate`, `Switches`, `Temperature`, `Transfer`
  - `VBat`, `WaterHeating`, `AmbientLight`, `Panel`, `BatteryMngmt`,
    `Install`, `Connect`, `TimerConfig`, `BleDeviceManagement`,
    `BluetoothDevice`
  - `System`, `Resources`, `PowerMgmt`
- State responses include parameter maps with keys such as:
  - `tn`: topic name
  - `pn`: parameter name
  - `type`: value type
  - `avail`: availability
  - `perm`: permission
  - `v`: value
  - `min` / `max`: range

## Local Tools

Use these scripts for future captures:

```sh
python3 tools/pklg_analyze.py captures/example.pklg
python3 tools/pklg_analyze.py captures/one.pklg captures/two.pklg --diff-prefix
python3 tools/pklg_protocol.py captures/example.pklg > analysis/example-protocol.txt
```

The generated `analysis/*.txt` files may include local device identifiers or
phone/app identity values, so they are ignored by git.
