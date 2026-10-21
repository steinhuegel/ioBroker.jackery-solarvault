# ioBroker.jackery-solarvault

ioBroker adapter for **Jackery SolarVault 3** energy storage systems. It reads the local MQTT data of the device and lets you control it. It is a port of the official Jackery Home Assistant integration ([Jackery-Official/jackery](https://github.com/Jackery-Official/jackery), MIT) and speaks the same protocol.

> Not an official Jackery product. Untested against real hardware so far: the protocol code is ported 1:1 and covered by unit tests, but please report anything that behaves differently on your device.

## How it works

The SolarVault publishes to an MQTT broker that you run (for example Mosquitto or the ioBroker MQTT adapter in broker mode). The adapter connects to the same broker as a client, polls the device every 5 seconds and writes the values into ioBroker states.

## Setup

1. Have an MQTT broker reachable by both the SolarVault and ioBroker.
2. In the Jackery app (version 2.0.0 or newer): **Device details > Settings > MQTT**. Enter broker IP, port, user and password and enable it. The app generates a **token**.
3. In the adapter settings enter the broker connection and add a row per host with its **serial number** and **token**. Several hosts are supported.
4. Start the instance. If the device never answers within 2 minutes, `info.tokenSuspect` is set and an error is logged (the device stays silent when it rejects a token).

Default topic prefix is `hb`. Used topics: `hb/device/<sn>/status`, `hb/device/<sn>/event` (subscribe), `hb/device/<sn>/action` (publish).

## States

Below `jackery-solarvault.0.<SN>.`:

| Channel | Content |
| --- | --- |
| `info` | `available`, `model`, `softver`, `serial`, `lastUpdate`, `tokenSuspect` |
| `status` | operating status (`states` map), work mode, on-grid / CT / meter link status, AC socket status |
| `battery` | SOC, average SOC, charge/discharge power, temperature (°C), battery count, charge/discharge energy (kWh) |
| `solar` | total power and energy, PV1 to PV4 |
| `grid` | grid port in/out power and energy, other load, max feed-in |
| `ac_socket` | AC socket input power and in/out energy |
| `energy` | energy flow statistics (PV to battery, battery to grid, ...) |
| `calc` | values calculated with the Jackery app formulas: `calc_grid_net_power`, `calc_home_power`, `calc_ac_socket_power`, `calc_batt_net_power`, charge/discharge power |
| `control` | writable settings, see below |
| `plug_<sn>` | Smart Plug: power, energy, switch, `commMode`, `mqttControllable`, `available` (up to 10) |
| `ct_<sn>` | Smart CT / meter: total, phase A/B/C forward and reverse power, forward/reverse energy, sub type |

Energy values are converted to kWh, temperature to °C. Sub-devices are created automatically when they show up and removed when they are unbound in the app. Sub-devices that have been silent for more than 60 s get `available = false`; the same applies to the host (`info.available`).

### Controls

| State | Device field | Notes |
| --- | --- | --- |
| `control.acSocketSwitch` | `swEps` | boolean |
| `control.autoStandbyAllowed` | `isAutoStandby` | boolean |
| `control.autoStandbyMode` | `autoStandby` | 0 invalid, 1 standby, 2 on |
| `control.socChargeLimit` | `socChgLimit` | limits (default 50-100 %) follow `minSocChg` / `maxSocChg` from the device |
| `control.socDischargeLimit` | `socDischgLimit` | limits (default 5-49 %) follow `minSocDischg` / `maxSocDischg` |
| `control.maxOutputPower` | `maxOutPw` | 0-2500 W |
| `control.reboot` | `reboot` | button, reboots the host |
| `plug_<sn>.switch` | type 103 | only when the plug has `commMode = 1` (local); cloud plugs (`commMode = 2`) must be switched in the app |

Write with `ack = false` (as usual in ioBroker). The state is confirmed with `ack = true` as soon as the device reports the new value.

Differences to the Home Assistant integration: read-only duplicates of controllable values (for example the separate `AC Socket Switch` sensor) are merged into the writable `control.*` states, and enum values are numbers with a `states` mapping instead of strings.

## Development

```
npm install
npm test
```

The tests run without ioBroker (`test/protocol.test.js` for the protocol logic, `test/main.smoke.test.js` with in-memory fakes for `mqtt` and `@iobroker/adapter-core`).

To try it on a system, copy the directory to `/opt/iobroker/node_modules/iobroker.jackery-solarvault`, run `npm install` there and `iobroker upload jackery-solarvault`, then add an instance in Admin. For a proper release you still need to fill in the author / repository fields in `package.json` and `io-package.json` and replace the placeholder icon.

## License

MIT. Protocol logic derived from the official Jackery Home Assistant integration, Copyright (c) 2025 Jackery (see `LICENSE`).
