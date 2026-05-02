# Truma iNet X PacketLogger Capture Manifest

Device:
- Mac model:
- macOS version:
- Truma app version:
- iNet X firmware/version if visible:
- Notes:

Capture package:
- Created:
- PacketLogger version if visible:
- Optional Wireshark version used for `.pcapng` export:

## 01_first_pairing.pklg

Expected important behavior:
- Unpaired iNet X, app sends the special request, iNet X starts normal Bluetooth pairing.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS Opened Truma app
- HH:MM:SS Tapped iNet X device
- HH:MM:SS Pairing popup appeared
- HH:MM:SS Accepted pairing
- HH:MM:SS App showed connected
- HH:MM:SS Stopped capture

## 02_reconnect_existing_pair.pklg

Expected important behavior:
- Already paired iNet X reconnects normally.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS Opened Truma app
- HH:MM:SS App connected to already-paired iNet X
- HH:MM:SS Stopped capture

## 03_read_state.pklg

Expected important behavior:
- App reads the current iNet X state after connecting.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS Opened Truma app
- HH:MM:SS App showed connected
- HH:MM:SS App displayed current state
- HH:MM:SS Stopped capture

## 04_change_temperature.pklg

Expected important behavior:
- Only one temperature value changes.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS App connected
- HH:MM:SS Temperature before:
- HH:MM:SS Changed temperature to:
- HH:MM:SS App confirmed/displayed new value
- HH:MM:SS Stopped capture

## 05_change_mode.pklg

Expected important behavior:
- Only one mode setting changes.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS App connected
- HH:MM:SS Mode before:
- HH:MM:SS Changed mode to:
- HH:MM:SS App confirmed/displayed new value
- HH:MM:SS Stopped capture

## 06_toggle_each_feature.pklg

Expected important behavior:
- One feature toggle changes per capture.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS App connected
- HH:MM:SS Toggle name:
- HH:MM:SS Toggle before:
- HH:MM:SS Toggle after:
- HH:MM:SS App confirmed/displayed new value
- HH:MM:SS Stopped capture

## 07_notifications_idle.pklg

Expected important behavior:
- App remains connected for 1-2 minutes without manual changes.

Timeline:
- HH:MM:SS Started PacketLogger capture
- HH:MM:SS App connected
- HH:MM:SS Began idle period
- HH:MM:SS Ended idle period
- HH:MM:SS Stopped capture
