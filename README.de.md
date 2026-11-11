# ioBroker.jackery-solarvault

*[English version](README.md)*

ioBroker-Adapter für **Jackery SolarVault 3** Speichersysteme. Er liest die lokalen MQTT-Daten des Geräts und kann es steuern. Er ist eine Portierung der offiziellen Jackery Home-Assistant-Integration ([Jackery-Official/jackery](https://github.com/Jackery-Official/jackery), MIT) und spricht dasselbe Protokoll.

> Kein offizielles Jackery-Produkt. Bisher nur mit der eigenen Hardware erprobt: Der Protokollcode ist 1:1 portiert und durch Unit-Tests abgedeckt. Bitte melde, wenn sich etwas an deinem Gerät anders verhält.

## Funktionsweise

Die SolarVault veröffentlicht ihre Daten an einen MQTT-Broker, den du selbst betreibst (zum Beispiel Mosquitto oder der ioBroker-MQTT-Adapter im Broker-Modus). Der Adapter verbindet sich als Client mit demselben Broker, fragt das Gerät alle 5 Sekunden ab und schreibt die Werte in ioBroker-Datenpunkte.

## Einrichtung

1. Ein MQTT-Broker muss sowohl von der SolarVault als auch von ioBroker erreichbar sein.
2. In der Jackery-App (Version 2.0.0 oder neuer): **Gerätedetails > Einstellungen > MQTT**. Broker-IP, Port, Benutzer und Passwort eintragen und aktivieren. Die App erzeugt einen **Token**.
3. In den Adapter-Einstellungen die Broker-Verbindung eintragen und pro Gerät eine Zeile mit **Seriennummer** und **Token** anlegen. Mehrere Geräte werden unterstützt.
4. Instanz starten. Antwortet das Gerät innerhalb von 2 Minuten nie, wird `info.tokenSuspect` gesetzt und ein Fehler protokolliert (das Gerät bleibt stumm, wenn es einen Token ablehnt).

Standard-Topic-Präfix ist `hb`. Verwendete Topics: `hb/device/<sn>/status`, `hb/device/<sn>/event`, `hb/device/<sn>/alert` (abonniert) und `hb/device/<sn>/action` (gesendet).

## Datenpunkte

Unterhalb von `jackery-solarvault.0.<SN>.`:

| Kanal | Inhalt |
| --- | --- |
| `info` | `available`, `model`, `softver`, `serial`, `lastUpdate`, `tokenSuspect` |
| `status` | Betriebsstatus (mit `states`-Zuordnung), Arbeitsmodus, Status von Netz / CT / Zähleranbindung, Status der AC-Steckdose |
| `battery` | SOC, durchschnittlicher SOC, Lade-/Entladeleistung, Temperatur (°C), Anzahl Batterien, Lade-/Entladeenergie (kWh), Zustand, Stack-Leistungen |
| `solar` | Gesamtleistung und -energie, PV1 bis PV4 |
| `grid` | Netzanschluss Ein-/Ausgangsleistung und -energie, sonstige Last, maximale Einspeisung |
| `ac_socket` | Eingangsleistung der AC-Steckdose und Energie ein/aus |
| `energy` | Energiefluss-Statistik (PV zu Batterie, Batterie zu Netz, ...), CT-Bezugs-/Einspeiseenergie auf Systemebene (neuere Firmware) |
| `network` | Ethernet verbunden, WLAN-Signal (dBm), WLAN-SSID, WLAN-/Ethernet-IP |
| `settings` | vom Gerät zurückgelesene Einstellungen (nur lesend): Standardleistung, Zähler folgen, Off-Grid-Rückfall, Zwangsladen, max. Systemleistung, Standby-Schwellen (Wechselrichter, Netz), max. PV-Ladeleistung |
| `calc` | mit den Formeln der Jackery-App berechnete Werte: `calc_grid_net_power`, `calc_home_power`, `calc_ac_socket_power`, `calc_batt_net_power`, Lade-/Entladeleistung |
| `control` | schreibbare Einstellungen, siehe unten |
| `alert` | letzte Alarmmeldung des Geräts |
| `plug_<sn>` | Smart Plug: Leistung, Energie, Schalter, `commMode`, `mqttControllable`, `available` (bis zu 10) |
| `ct_<sn>` | Smart CT / Zähler: Gesamt-, Phase-A/B/C-Bezugs- und -Einspeiseleistung, Bezugs-/Einspeiseenergie, Subtyp |
| `exp_<sn>` | Erweiterungsbatterie (z. B. BP2500): Lade- und Entladeenergie |

Energiewerte werden in kWh umgerechnet, Temperaturen in °C. Untergeräte werden automatisch angelegt, sobald sie auftauchen, und entfernt, wenn sie in der App entkoppelt werden. Untergeräte, die länger als 60 s schweigen, bekommen `available = false`; dasselbe gilt für das Hauptgerät (`info.available`).

### Steuerung

| Datenpunkt | Geräte-Feld | Hinweis |
| --- | --- | --- |
| `control.acSocketSwitch` | `swEps` | boolean |
| `control.autoStandbyAllowed` | `isAutoStandby` | boolean |
| `control.autoStandbyMode` | `autoStandby` | 0 ungültig, 1 Standby, 2 an |
| `control.socChargeLimit` | `socChgLimit` | Grenzen (Standard 50-100 %) folgen `minSocChg` / `maxSocChg` vom Gerät |
| `control.socDischargeLimit` | `socDischgLimit` | Grenzen (Standard 5-49 %) folgen `minSocDischg` / `maxSocDischg` |
| `control.maxOutputPower` | `maxOutPw` | 0-2500 W in 10-W-Schritten |
| `control.reboot` | `reboot` | Taster, startet das Hauptgerät neu |
| `plug_<sn>.switch` | Typ 103 | nur wenn der Plug `commMode = 1` (lokal) hat; Cloud-Plugs (`commMode = 2`) müssen in der App geschaltet werden |

#### Zusätzliche Steuerungen (optional)

Aktiviere in den Adapter-Einstellungen „Enable additional controls“, um diese schreibbaren Datenpunkte zu erhalten. Ohne den Haken sind die aktuellen Werte weiterhin nur lesend sichtbar (`settings.*`, `status.work_mode`, `grid.max_feed_grid_power`).

| Datenpunkt | Geräte-Feld | Hinweis |
| --- | --- | --- |
| `control.workMode` | `workModel` | 2 Eigenverbrauch, 4 Benutzerdefiniert, 7 Tarif, 8 KI |
| `control.defaultOutputPower` | `defaultPw` | 0-200 W in 10-W-Schritten, Ersatzleistung im benutzerdefinierten Modus (wenn kein Plan-Eintrag aktiv ist) |
| `control.maxFeedGrid` | `maxFeedGrid` | Exportgrenze ins öffentliche Netz, 0-2500 W in 10-W-Schritten |
| `control.followMeter` | `isFollowMeterPw` | nur im benutzerdefinierten Modus wirksam |
| `control.offGridFallback` | `offGridDown` | boolean |
| `control.forceCharge` | `socForceChg` | boolean |

Der Zeitplan des benutzerdefinierten Modus liegt in der Jackery-Cloud und lässt sich lokal weder lesen noch ändern.

### Erweiterungsbatterien und Alarme

- `exp_<sn>`: Erweiterungsbatterien (z. B. BP2500) werden an den Energiestatistiken (Typ 23, etwa alle 10 Minuten) erkannt und liefern `charge_energy`, `discharge_energy` und `available`. Das Gerät veröffentlicht für sie weder Echtzeitleistung noch einen eigenen SOC; ihr SOC steckt im gemeinsamen SOC und in `battery.battery_count`. Die Batterie-Leistungswerte des Speichers gelten nur für die Haupteinheit.
- `alert.*`: Das Topic `hb/device/<sn>/alert` wird abonniert (Störungen, Sturmwarnung, Schwellenalarme): `alertId`, `recordTs`, `json` und `trigger`, das bei jeder Alarmmeldung auf `true` gesetzt wird (in Skripten selbst zurücksetzen).

Schreibe mit `ack = false` (wie in ioBroker üblich). Der Datenpunkt wird mit `ack = true` bestätigt, sobald das Gerät den neuen Wert meldet.

Unterschiede zur Home-Assistant-Integration: Nur lesende Duplikate steuerbarer Werte (zum Beispiel der separate Sensor „AC Socket Switch“) sind in die schreibbaren `control.*`-Datenpunkte zusammengeführt, und Aufzählungswerte sind Zahlen mit `states`-Zuordnung statt Zeichenketten.

Hinweis zu `calc.calc_home_power`: Der Wert ist nicht auf 0 begrenzt. Mit einer zweiten PV-Anlage im Haus bedeutet ein negativer Wert Überschuss. Den echten Hausverbrauch kennt der Adapter dann nicht, weil er die Erzeugung der anderen Anlage nicht sieht.

### Fehlersuche

Mit „Log raw MQTT messages“ in den Adapter-Einstellungen schreibt der Adapter jede empfangene Nachricht auf Info-Ebene ins Log (`RAW status: {...}`). Token, WLAN-Name und deine Seriennummer werden automatisch maskiert, die Zeilen lassen sich also in einem Forum oder GitHub-Issue posten. Danach wieder ausschalten.

## Installation

Per GitHub-URL, auf dem ioBroker-System:

```
iobroker url https://github.com/steinhuegel/ioBroker.jackery-solarvault
```

Anschließend in der Admin-Oberfläche eine Instanz anlegen (bzw. die vorhandene neu starten).

## Entwicklung

```
npm install
npm test
```

Die Tests laufen ohne ioBroker (`test/protocol.test.js` für die Protokolllogik, `test/main.smoke.test.js` mit In-Memory-Attrappen für `mqtt` und `@iobroker/adapter-core`).

## Lizenz

MIT. Die Protokolllogik stammt von der offiziellen Jackery Home-Assistant-Integration, Copyright (c) 2025 Jackery (siehe `LICENSE`). Zusätzliche Erkenntnisse (Erweiterungsbatterien, Alarm-Topic, weitere Steuerfelder, Korrektur der Netzpriorität) stammen aus dem Community-Projekt csoscd/ha-solarvault (ebenfalls MIT).
