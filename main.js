'use strict';

/*
 * ioBroker adapter for Jackery SolarVault 3 (local MQTT).
 *
 * Port of the official Jackery Home Assistant integration
 * (MIT, Copyright (c) 2025 Jackery) https://github.com/Jackery-Official/jackery
 */

const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');

const {
    JackeryCore,
    CT_SUBTYPE_MAP,
    COMM_MODE_LABELS,
    extractCtGridPower,
    plugCommMode,
    plugMqttControlAllowed,
    shouldCreatePlugSwitch,
    subdeviceSn,
    pyOr,
    firstDefined,
} = require('./lib/protocol');
const { SENSORS, CONTROLS, EXTRA_CONTROLS, EXPANSION_STATES, PLUG_STATES, CT_STATES } = require('./lib/datapoints');

const POLL_INTERVAL_MS = 5000;

const GROUP_NAMES = {
    info: 'Information',
    status: 'Status',
    battery: 'Battery',
    solar: 'Solar',
    grid: 'Grid',
    ac_socket: 'AC socket',
    energy: 'Energy flow statistics',
    network: 'Network',
    settings: 'Settings read back from the device',
    calc: 'Calculated values',
    control: 'Controls',
    alert: 'Device alerts',
};

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function idSafe(text) {
    return String(text).replace(/[^A-Za-z0-9_-]/g, '_');
}

function round(n, digits = 4) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/** Mask token, WiFi name and the own serial number in a raw payload (for logs that are copied into forums). */
function redactRaw(text, sn) {
    return String(text)
        .replace(/("token"\s*:\s*)("[^"]*"|\d+)/g, '$1"XXXX"')
        .replace(/("wname"\s*:\s*)"[^"]*"/g, '$1"XXXX"')
        .split(sn)
        .join('XXXX');
}

class JackerySolarvault extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] */
    constructor(options) {
        super({ ...options, name: 'jackery-solarvault' });
        this.devices = new Map(); // idSn -> device runtime
        this.client = null;
        this.valueCache = new Map();
        this.pollTimer = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------

    async onReady() {
        await this.setState('info.connection', false, true);

        const cfg = this.config;
        const host = String(cfg.mqttHost || '').trim();
        if (!host) {
            this.log.error('No MQTT broker configured. Please open the adapter settings.');
            return;
        }
        this.prefix = String(cfg.topicPrefix || 'hb').replace(/^\/+|\/+$/g, '') || 'hb';

        const seen = new Set();
        for (const entry of Array.isArray(cfg.devices) ? cfg.devices : []) {
            if (!entry || entry.enabled === false) {
                continue;
            }
            const sn = String(entry.sn || '').trim();
            const token = String(entry.token || '').trim();
            if (!sn) {
                continue;
            }
            if (!token) {
                this.log.warn(`Device ${sn}: no token configured (generate it in the Jackery app under Device details > Settings > MQTT).`);
            }
            if (seen.has(sn)) {
                this.log.warn(`Device ${sn} is configured more than once, ignoring duplicate.`);
                continue;
            }
            seen.add(sn);
            const idSn = idSafe(sn);
            const core = new JackeryCore({ deviceSn: sn, log: this.log });
            const dev = { sn, idSn, token, core, available: null, tokenWarned: false, ready: null };
            this.devices.set(idSn, dev);
            dev.ready = this.createDeviceObjects(dev);
        }

        if (!this.devices.size) {
            this.log.error('No device configured. Add at least one SolarVault serial number and token in the adapter settings.');
            return;
        }
        await Promise.all([...this.devices.values()].map(d => d.ready));

        await this.subscribeStatesAsync('*.control.*');
        await this.subscribeStatesAsync('*.plug_*.switch');

        this.connectMqtt(host);
        this.pollTimer = this.setInterval(() => this.tick(), POLL_INTERVAL_MS);
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
            }
            if (this.client) {
                this.client.end(true);
            }
            this.setState('info.connection', false, true);
        } catch (e) {
            // ignore
        }
        callback();
    }

    // ------------------------------------------------------------------
    // MQTT
    // ------------------------------------------------------------------

    connectMqtt(host) {
        const cfg = this.config;
        const port = Number(cfg.mqttPort) || (cfg.mqttTls ? 8883 : 1883);
        const url = `${cfg.mqttTls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
        this.log.info(`Connecting to MQTT broker ${url}`);

        this.client = mqtt.connect(url, {
            username: cfg.mqttUser || undefined,
            password: cfg.mqttPassword || undefined,
            clientId: `iobroker-jackery-${this.instance}-${Math.random().toString(16).slice(2, 8)}`,
            reconnectPeriod: 5000,
            connectTimeout: 15000,
            rejectUnauthorized: cfg.mqttRejectUnauthorized !== false,
            clean: true,
        });

        this.client.on('connect', () => {
            this.log.info('MQTT connected');
            this.setState('info.connection', true, true);
            for (const dev of this.devices.values()) {
                const topics = [
                    `${this.prefix}/device/${dev.sn}/status`,
                    `${this.prefix}/device/${dev.sn}/event`,
                    `${this.prefix}/device/${dev.sn}/alert`,
                ];
                this.client.subscribe(topics, { qos: 1 }, err => {
                    if (err) {
                        this.log.error(`Subscribe failed for ${dev.sn}: ${err.message}`);
                    } else {
                        this.log.debug(`Subscribed: ${topics.join(', ')}`);
                    }
                });
                this.sendPolls(dev);
            }
        });
        this.client.on('close', () => this.setState('info.connection', false, true));
        this.client.on('error', err => this.log.warn(`MQTT error: ${err.message}`));
        this.client.on('message', (topic, payload) => {
            this.onMqttMessage(topic, payload.toString('utf8')).catch(e =>
                this.log.error(`Error handling message on ${topic}: ${e.message}`),
            );
        });
    }

    publish(dev, body) {
        if (!this.client || !this.client.connected) {
            return false;
        }
        const topic = `${this.prefix}/device/${dev.sn}/action`;
        this.client.publish(topic, JSON.stringify(body), { qos: 0, retain: false }, err => {
            if (err) {
                this.log.warn(`Publish to ${topic} failed: ${err.message}`);
            }
        });
        return true;
    }

    randomId() {
        return 1000 + Math.floor(Math.random() * 9000);
    }

    baseMessage(dev, type, body, eventId = 0) {
        const msg = {
            type,
            eventId,
            messageId: this.randomId(),
            ts: Math.floor(Date.now() / 1000),
            body,
        };
        if (dev.token) {
            msg.token = dev.token;
        }
        return msg;
    }

    sendPolls(dev) {
        // 25 = device status, 105 = system full data, 2 = read all settings, 100 = sub-devices (2 = CT family, 6 = plug)
        this.publish(dev, this.baseMessage(dev, 25, null));
        this.publish(dev, this.baseMessage(dev, 105, null));
        this.publish(dev, this.baseMessage(dev, 2, null));
        this.publish(dev, this.baseMessage(dev, 100, { devType: 2 }));
        this.publish(dev, this.baseMessage(dev, 100, { devType: 6 }));
    }

    tick() {
        for (const dev of this.devices.values()) {
            this.sendPolls(dev);
            this.checkAvailability(dev).catch(e => this.log.error(`Availability check failed: ${e.message}`));
        }
    }

    async checkAvailability(dev) {
        const core = dev.core;
        if (core.isOffline()) {
            await this.setAvailable(dev, false);
        } else {
            await this.updateSubdevices(dev);
            await this.updateExpansionBatteries(dev);
        }
        if (core.tokenLooksInvalid() && !dev.tokenWarned) {
            dev.tokenWarned = true;
            this.log.error(
                `Device ${dev.sn} never responded. The token or serial number is probably wrong ` +
                    '(the device does not answer when it rejects a token).',
            );
            await this.setStateChangedAsync(`${dev.idSn}.info.tokenSuspect`, true, true);
        }
    }

    async onMqttMessage(topic, text) {
        // find device by topic
        const m = topic.startsWith(`${this.prefix}/device/`) ? topic.slice(this.prefix.length + 8).split('/') : null;
        if (!m || m.length < 2) {
            return;
        }
        const dev = this.devices.get(idSafe(m[0]));
        if (!dev || dev.sn !== m[0]) {
            return;
        }
        await dev.ready;
        this.log.silly(`${topic}: ${text}`);
        if (this.config.logRawMessages) {
            this.log.info(`RAW ${m[1]}: ${redactRaw(text, dev.sn)}`);
        }

        if (m[1] === 'alert') {
            await this.onAlert(dev, text);
            return;
        }

        const res = dev.core.handleMessage(text);
        if (res.reauth && !dev.tokenWarned) {
            dev.tokenWarned = true;
            this.log.error(`Device ${dev.sn}: ${res.reauth}. Please update the token in the adapter settings.`);
            await this.setStateChangedAsync(`${dev.idSn}.info.tokenSuspect`, true, true);
        }
        for (const sn of res.removed) {
            await this.removeSubdeviceObjects(dev, sn);
        }
        if (!res.ok) {
            return;
        }
        if (dev.tokenWarned && !res.reauth) {
            dev.tokenWarned = false;
            await this.setStateChangedAsync(`${dev.idSn}.info.tokenSuspect`, false, true);
        }

        await this.setAvailable(dev, true);
        if (res.metaChanged) {
            await this.updateMeta(dev);
        }
        await this.updateMainStates(dev);
        await this.updateSubdevices(dev);
        await this.updateExpansionBatteries(dev);
    }

    async onAlert(dev, text) {
        const alert = dev.core.handleAlert(text);
        if (!alert) {
            return;
        }
        this.log.warn(`Device ${dev.sn} alert: id=${alert.alertId} ${JSON.stringify(alert.extra)}`);
        const root = `${dev.idSn}.alert`;
        await this.setStateAsync(`${root}.alertId`, alert.alertId === null ? 0 : Number(alert.alertId), true);
        await this.setStateAsync(`${root}.recordTs`, alert.recordTs === null ? Date.now() : Number(alert.recordTs) * 1000, true);
        await this.setStateAsync(`${root}.json`, JSON.stringify({ alertId: alert.alertId, recordTs: alert.recordTs, ...alert.extra }), true);
        await this.setStateAsync(`${root}.trigger`, true, true);
    }

    // ------------------------------------------------------------------
    // object creation
    // ------------------------------------------------------------------

    async ensureDevice(id, name) {
        await this.extendObjectAsync(id, { type: 'device', common: { name }, native: {} });
    }

    async ensureChannel(id, name) {
        await this.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
    }

    async ensureState(id, def, extra = {}) {
        const common = {
            name: def.name,
            type: def.type || 'number',
            role: def.role || 'value',
            read: true,
            write: false,
            ...extra,
        };
        if (def.unit) {
            common.unit = def.unit;
        }
        if (def.states) {
            common.states = def.states;
        }
        await this.extendObjectAsync(id, { type: 'state', common, native: {} });
    }

    async createDeviceObjects(dev) {
        const root = dev.idSn;
        await this.ensureDevice(root, `Jackery ${dev.sn}`);
        for (const [group, name] of Object.entries(GROUP_NAMES)) {
            await this.ensureChannel(`${root}.${group}`, name);
        }

        await this.ensureState(`${root}.info.available`, { name: 'Device available', type: 'boolean', role: 'indicator.reachable' });
        await this.ensureState(`${root}.info.tokenSuspect`, { name: 'Token or serial number probably invalid', type: 'boolean', role: 'indicator.alarm' });
        await this.ensureState(`${root}.info.serial`, { name: 'Serial number', type: 'string', role: 'text' });
        await this.ensureState(`${root}.info.model`, { name: 'Model', type: 'string', role: 'text' });
        await this.ensureState(`${root}.info.softver`, { name: 'Firmware version', type: 'string', role: 'text' });
        await this.ensureState(`${root}.info.lastUpdate`, { name: 'Last message received', type: 'number', role: 'date' });
        await this.setStateChangedAsync(`${root}.info.serial`, dev.sn, true);
        await this.setStateChangedAsync(`${root}.info.available`, false, true);
        await this.setStateChangedAsync(`${root}.info.tokenSuspect`, false, true);

        for (const [id, def] of Object.entries(SENSORS)) {
            await this.ensureState(`${root}.${def.group}.${id}`, def);
        }
        for (const [id, def] of Object.entries(CONTROLS)) {
            await this.ensureState(`${root}.control.${id}`, def, {
                write: true,
                ...(def.min !== undefined ? { min: def.min, max: def.max } : {}),
            });
        }
        await this.ensureState(`${root}.control.reboot`, { name: 'Reboot host', type: 'boolean', role: 'button' }, { write: true, read: false });

        if (this.config.enableExtraControls) {
            for (const [id, def] of Object.entries(EXTRA_CONTROLS)) {
                await this.ensureState(`${root}.control.${id}`, def, {
                    write: true,
                    ...(def.min !== undefined ? { min: def.min, max: def.max, step: def.step } : {}),
                });
            }
        }

        await this.ensureState(`${root}.alert.alertId`, { name: 'Last alert id', type: 'number', role: 'value' });
        await this.ensureState(`${root}.alert.recordTs`, { name: 'Last alert time', type: 'number', role: 'date' });
        await this.ensureState(`${root}.alert.json`, { name: 'Last alert (JSON)', type: 'string', role: 'json' });
        await this.ensureState(`${root}.alert.trigger`, { name: 'Set to true on every alert message (reset it yourself)', type: 'boolean', role: 'indicator.alarm' }, { write: true });
    }

    async createExpansionObjects(dev, sn) {
        const base = `${dev.idSn}.exp_${idSafe(sn)}`;
        this.log.info(`Discovered expansion battery ${sn} on ${dev.sn}`);
        await this.ensureDevice(base, `Jackery ${dev.sn} expansion battery ${sn}`);
        await this.ensureState(`${base}.available`, { name: 'Available', type: 'boolean', role: 'indicator.reachable' });
        for (const [id, def] of Object.entries(EXPANSION_STATES)) {
            await this.ensureState(`${base}.${id}`, def);
        }
    }

    async updateExpansionBatteries(dev) {
        const { newBatteries, availability } = dev.core.checkExpansionBatteries();
        dev.expReady = dev.expReady || new Map();
        for (const sn of newBatteries) {
            dev.expReady.set(sn, this.createExpansionObjects(dev, sn));
        }
        if (dev.available === false) {
            return;
        }
        for (const [sn, available] of availability) {
            // a concurrent call (poll timer vs. incoming message) must wait until the objects exist
            await dev.expReady.get(sn);
            const base = `${dev.idSn}.exp_${idSafe(sn)}`;
            await this.put(`${base}.available`, available);
            const exp = dev.core.expansionBatteries.get(sn) || {};
            for (const [id, def] of Object.entries(EXPANSION_STATES)) {
                if (exp[def.key] !== undefined) {
                    await this.put(`${base}.${id}`, this.convert(def, exp[def.key]));
                }
            }
        }
    }

    async removeSubdeviceObjects(dev, sn) {
        for (const prefix of ['plug', 'ct']) {
            const id = `${dev.idSn}.${prefix}_${idSafe(sn)}`;
            try {
                await this.delObjectAsync(id, { recursive: true });
                this.log.info(`Sub-device ${sn} was unbound, removed ${id}`);
            } catch (e) {
                // does not exist
            }
        }
        for (const key of [...this.valueCache.keys()]) {
            if (key.startsWith(`${dev.idSn}.plug_${idSafe(sn)}.`) || key.startsWith(`${dev.idSn}.ct_${idSafe(sn)}.`)) {
                this.valueCache.delete(key);
            }
        }
    }

    async createSubdeviceObjects(dev, entry) {
        const { sn, group, devType, item } = entry;
        const base = `${dev.idSn}.${group}_${idSafe(sn)}`;
        const kind = group === 'ct' ? 'CT' : 'Plug';
        this.log.info(`Discovered ${kind} ${sn} on ${dev.sn} (devType=${devType})`);
        await this.ensureDevice(base, `Jackery ${dev.sn} ${kind} ${sn}`);
        await this.ensureState(`${base}.available`, { name: 'Available', type: 'boolean', role: 'indicator.reachable' });
        await this.ensureState(`${base}.commState`, { name: 'Communication state', type: 'number', role: 'value' });

        if (group === 'ct') {
            for (const [id, def] of Object.entries(CT_STATES)) {
                await this.ensureState(`${base}.${id}`, def);
            }
            await this.ensureState(`${base}.subType`, { name: 'CT sub type', type: 'number', role: 'value', states: CT_SUBTYPE_MAP });
        } else {
            for (const [id, def] of Object.entries(PLUG_STATES)) {
                await this.ensureState(`${base}.${id}`, def);
            }
            await this.ensureState(`${base}.commMode`, { name: 'Communication mode (1=local, 2=cloud)', type: 'number', role: 'value', states: COMM_MODE_LABELS });
            await this.ensureState(`${base}.mqttControllable`, { name: 'Controllable via MQTT', type: 'boolean', role: 'indicator' });
            if (shouldCreatePlugSwitch(item)) {
                await this.ensureState(`${base}.switch`, { name: 'Switch', type: 'boolean', role: 'switch' }, { write: true });
            }
        }
    }

    // ------------------------------------------------------------------
    // state updates
    // ------------------------------------------------------------------

    /** Write a value with ack=true only when it changed (or was written by a user meanwhile). */
    async put(id, val) {
        if (val === undefined || val === null || (typeof val === 'number' && Number.isNaN(val))) {
            return;
        }
        if (this.valueCache.get(id) === val) {
            return;
        }
        this.valueCache.set(id, val);
        await this.setStateAsync(id, val, true);
    }

    async setAvailable(dev, available) {
        if (dev.available === available) {
            if (available) {
                await this.put(`${dev.idSn}.info.lastUpdate`, Date.now());
            }
            return;
        }
        dev.available = available;
        await this.setStateAsync(`${dev.idSn}.info.available`, available, true);
        if (!available) {
            this.log.warn(`Device ${dev.sn} has not reported for more than 60 s, marked as unavailable.`);
            for (const sn of dev.core.knownSubdevices.keys()) {
                await this.setSubAvailable(dev, sn, false);
            }
            for (const sn of dev.core.expansionBatteries.keys()) {
                await this.put(`${dev.idSn}.exp_${idSafe(sn)}.available`, false);
            }
        } else {
            this.log.info(`Device ${dev.sn} is available.`);
        }
        if (available) {
            await this.put(`${dev.idSn}.info.lastUpdate`, Date.now());
        }
    }

    async updateMeta(dev) {
        await this.put(`${dev.idSn}.info.model`, dev.core.model);
        if (dev.core.softVer !== null) {
            await this.put(`${dev.idSn}.info.softver`, String(dev.core.softVer));
        }
    }

    convert(def, value) {
        if (def.type === 'string') {
            return value === null || value === undefined ? undefined : String(value);
        }
        if (def.type === 'boolean') {
            if (typeof value === 'boolean') {
                return value;
            }
            const n = Number(value);
            return Number.isFinite(n) ? n !== 0 : undefined;
        }
        let v = value;
        if (isObj(v)) {
            v = firstDefined(v.pvPw, v.w, v.power);
        }
        const n = Number(v);
        if (!Number.isFinite(n)) {
            return undefined;
        }
        if (def.int) {
            return Math.trunc(n);
        }
        if (def.scale) {
            return round(n * def.scale, 4);
        }
        return n;
    }

    async updateMainStates(dev) {
        const cache = dev.core.cache;
        const root = dev.idSn;

        for (const [id, def] of Object.entries(SENSORS)) {
            if (!(def.key in cache)) {
                continue;
            }
            const val = this.convert(def, cache[def.key]);
            await this.put(`${root}.${def.group}.${id}`, val);
        }

        for (const [id, def] of Object.entries(CONTROLS)) {
            const stateId = `${root}.control.${id}`;
            if (def.minKey && def.minKey in cache && def.maxKey in cache) {
                const min = Number(cache[def.minKey]);
                const max = Number(cache[def.maxKey]);
                const limitKey = `${stateId}#limits`;
                if (Number.isFinite(min) && Number.isFinite(max) && this.valueCache.get(limitKey) !== `${min}/${max}`) {
                    this.valueCache.set(limitKey, `${min}/${max}`);
                    await this.extendObjectAsync(stateId, { common: { min, max } });
                }
            }
            if (def.key in cache) {
                await this.put(stateId, this.convert({ ...def, bool: undefined }, cache[def.key]));
            }
        }
        if (this.config.enableExtraControls) {
            for (const [id, def] of Object.entries(EXTRA_CONTROLS)) {
                if (def.key in cache) {
                    await this.put(`${root}.control.${id}`, this.convert(def, cache[def.key]));
                }
            }
        }
    }

    async setSubAvailable(dev, sn, available) {
        for (const group of ['plug', 'ct']) {
            if (dev.core.knownSubdevices.get(sn) === group) {
                await this.put(`${dev.idSn}.${group}_${idSafe(sn)}.available`, available);
            }
        }
    }

    async updateSubdevices(dev) {
        const core = dev.core;
        const { newDevices, availability } = core.checkSubdevices();
        for (const entry of newDevices) {
            await this.createSubdeviceObjects(dev, entry);
        }
        if (dev.available === false) {
            return;
        }
        for (const [sn, available] of availability) {
            await this.setSubAvailable(dev, sn, available);
        }

        for (const [sn, group] of core.knownSubdevices) {
            const base = `${dev.idSn}.${group}_${idSafe(sn)}`;
            if (group === 'ct') {
                const item = (core.cache.cts || []).find(c => isObj(c) && subdeviceSn(c) === sn);
                if (!item) {
                    continue;
                }
                const [fwd, rev, hasPower] = extractCtGridPower(item);
                if (hasPower) {
                    await this.put(`${base}.power_total_forward`, fwd);
                    await this.put(`${base}.power_total_reverse`, rev);
                }
                for (const [id, def] of Object.entries(CT_STATES)) {
                    if (!def.keys) {
                        continue;
                    }
                    const raw = firstDefined(...def.keys.map(k => item[k]));
                    if (raw !== undefined) {
                        await this.put(`${base}.${id}`, this.convert(def, raw));
                    }
                }
                if (item.subType !== undefined && item.subType !== null) {
                    await this.put(`${base}.subType`, Number(item.subType));
                }
                if (item.commState !== undefined && item.commState !== null) {
                    await this.put(`${base}.commState`, Number(item.commState));
                }
            } else {
                const item = core.findPlug(sn);
                if (!item) {
                    continue;
                }
                const power = firstDefined(item.outPw, item.power);
                if (power !== undefined) {
                    await this.put(`${base}.power`, this.convert(PLUG_STATES.power, power));
                }
                if (item.totalEgy !== undefined && item.totalEgy !== null) {
                    await this.put(`${base}.energy`, this.convert(PLUG_STATES.energy, item.totalEgy));
                }
                const sw = firstDefined(item.switchSta, item.sysSwitch);
                if (sw !== undefined) {
                    await this.put(`${base}.switch`, Number(sw) !== 0);
                }
                const mode = plugCommMode(item);
                if (mode !== null) {
                    await this.put(`${base}.commMode`, mode);
                }
                if (item.commState !== undefined && item.commState !== null) {
                    await this.put(`${base}.commState`, Number(item.commState));
                }
                await this.put(`${base}.mqttControllable`, plugMqttControlAllowed(item)[0]);
            }
        }
    }

    // ------------------------------------------------------------------
    // commands
    // ------------------------------------------------------------------

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        // <ns>.<idSn>.<...>
        const local = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
        const parts = local.split('.');
        const dev = this.devices.get(parts[0]);
        if (!dev) {
            return;
        }
        // allow the next device echo to be written with ack=true
        this.valueCache.delete(local);

        try {
            if (parts[1] === 'control') {
                await this.handleControl(dev, parts[2], state.val, local);
            } else if (parts[1] && parts[1].startsWith('plug_') && parts[2] === 'switch') {
                await this.handlePlugSwitch(dev, parts[1], !!state.val, local);
            }
        } catch (e) {
            this.log.error(`Command for ${local} failed: ${e.message}`);
        }
    }

    async handleControl(dev, name, val, localId) {
        if (name === 'reboot') {
            if (val) {
                this.log.info(`Rebooting host ${dev.sn}`);
                this.sendControl(dev, { reboot: 1 });
                await this.setStateAsync(localId, false, true);
            }
            return;
        }
        let def = CONTROLS[name];
        if (!def && this.config.enableExtraControls) {
            def = EXTRA_CONTROLS[name];
        }
        if (!def) {
            return;
        }
        let value;
        if (def.type === 'boolean') {
            value = val ? 1 : 0;
        } else {
            value = Math.trunc(Number(val));
            if (!Number.isFinite(value)) {
                this.log.warn(`Invalid value for ${localId}: ${val}`);
                return;
            }
            const obj = await this.getObjectAsync(localId);
            const min = obj && obj.common && obj.common.min !== undefined ? obj.common.min : def.min;
            const max = obj && obj.common && obj.common.max !== undefined ? obj.common.max : def.max;
            if (min !== undefined && value < min) {
                value = min;
            }
            if (max !== undefined && value > max) {
                value = max;
            }
            if (def.states && !(value in def.states)) {
                this.log.warn(`Invalid value for ${localId}: ${val}`);
                return;
            }
            if (def.step && value % def.step !== 0) {
                value = Math.round(value / def.step) * def.step;
            }
        }
        this.log.info(`Set ${def.param}=${value} on ${dev.sn}`);
        this.sendControl(dev, { [def.param]: value });
    }

    sendControl(dev, params) {
        const msg = this.baseMessage(dev, 1, { cmd: 5, rc: 1, ...params }, 3);
        if (!this.publish(dev, msg)) {
            this.log.warn('MQTT not connected, command not sent.');
        }
    }

    async handlePlugSwitch(dev, segment, on, localId) {
        const sn = [...dev.core.knownSubdevices.keys()].find(s => `plug_${idSafe(s)}` === segment);
        if (!sn) {
            return;
        }
        const item = dev.core.findPlug(sn) || {};
        const [allowed, reason] = plugMqttControlAllowed(item);
        if (!allowed) {
            this.log.warn(`Plug ${sn} control blocked: ${reason}`);
            const cur = pyOr(item.switchSta, item.sysSwitch);
            await this.setStateAsync(localId, Number(cur) !== 0, true);
            return;
        }
        const msg = this.baseMessage(dev, 103, {
            deviceSn: sn,
            devType: item.devType === undefined ? 6 : item.devType,
            sysSwitch: on ? 1 : 0,
        });
        if (!this.publish(dev, msg)) {
            this.log.warn('MQTT not connected, command not sent.');
            return;
        }
        this.log.info(`Set plug ${sn} switch=${on ? 1 : 0}`);
        // optimistic update like the HA integration
        dev.core.applyPlugSwitchCache(sn, on);
        await this.setStateAsync(localId, on, true);
        this.valueCache.set(localId, on);
    }
}

if (require.main !== module) {
    /** @param {Partial<utils.AdapterOptions>} [options] */
    module.exports = options => new JackerySolarvault(options);
} else {
    new JackerySolarvault();
}
