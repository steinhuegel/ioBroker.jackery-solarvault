'use strict';

/**
 * Jackery SolarVault 3 protocol core.
 *
 * Pure logic (no ioBroker / MQTT dependencies): message parsing, cache merging,
 * energy-flow calculation and sub-device tracking. Ported from the official
 * Jackery Home Assistant integration (MIT, Copyright (c) 2025 Jackery),
 * https://github.com/Jackery-Official/jackery
 */

const OFFLINE_TIMEOUT = 60; // seconds without a message -> unavailable
const REAUTH_HINT_TIMEOUT = 120; // seconds without any message after start -> token probably wrong

const DEVICE_TYPE_MODEL_MAP = {
    1: 'Battery Pack',
    2: 'CT/Meter Collector/Meter',
    3: 'DIY3',
    4: 'Meter Collector',
};
const DEFAULT_MODEL = 'Energy Monitor';

const CT_SUBTYPE_MAP = {
    1: 'Shelly Single Phase',
    2: 'Shelly Three Phase',
    3: 'Shelly 63A',
    4: 'Eastron Single Phase (4002)',
    5: 'Eastron Three Phase (4003)',
    6: 'Jackery Wireless Smart Meter (US L1/L2 4007)',
    7: 'Jackery Smart Meter 3P (UK 4008)',
};

const FUNC_ENABLE_BITS = {
    0: 'aerosol',
    1: 'soc_calibration',
    2: 'low_power',
    3: 'soh_calibration',
    4: 'pcs_comm_diag',
    5: 'shutdown_2h',
    6: 'fault_shutdown',
    7: 'epo',
    8: 'func_48v',
    9: 'ethernet_debug',
    10: 'energy_flow_fill',
    11: 'smart_plug_first',
};

const FLAT_PAYLOAD_KEYS = new Set([
    'batSoc',
    'soc',
    'pvPw',
    'stat',
    'workMode',
    'inOngridPw',
    'outOngridPw',
    'gridInPw',
    'gridOutPw',
    'inGridSidePw',
    'outGridSidePw',
    'swEpsInPw',
    'swEpsOutPw',
    'batInPw',
    'batOutPw',
    'otherLoadPw',
]);

const CT_ITEM_DEV_TYPES = new Set([2, 3, 4]);
const PLUG_ITEM_DEV_TYPES = new Set([6]);

const COMM_MODE_LOCAL = 1;
const COMM_MODE_CLOUD = 2;
const COMM_MODE_LABELS = { 1: 'local', 2: 'cloud' };

// ---------------------------------------------------------------------------
// Small helpers (Python-like semantics where the original relies on them)
// ---------------------------------------------------------------------------

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python truthiness */
function truthy(v) {
    if (v === null || v === undefined) {
        return false;
    }
    if (Array.isArray(v)) {
        return v.length > 0;
    }
    if (isObj(v)) {
        return Object.keys(v).length > 0;
    }
    if (typeof v === 'number') {
        return v !== 0 && !Number.isNaN(v);
    }
    return Boolean(v);
}

/** Python `a or b or c` */
function pyOr(...values) {
    for (const v of values) {
        if (truthy(v)) {
            return v;
        }
    }
    return values[values.length - 1];
}

/** First value that is not null/undefined (Python `x if x is not None else y`) */
function firstDefined(...values) {
    for (const v of values) {
        if (v !== null && v !== undefined) {
            return v;
        }
    }
    return undefined;
}

function safeFloat(value, def = 0) {
    if (value === null || value === undefined) {
        return def;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
}

function fieldPresent(data, key) {
    return key in data && data[key] !== null && data[key] !== undefined;
}

function pickBestPowerNet(candidates) {
    if (!candidates.length) {
        return 0;
    }
    const nonZero = candidates.filter(v => Math.abs(v) > 0);
    if (nonZero.length) {
        return nonZero.reduce((best, v) => (Math.abs(v) > Math.abs(best) ? v : best));
    }
    return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// CT / grid helpers
// ---------------------------------------------------------------------------

/** @returns {[number, number, boolean]} [gridBuy, gridSell, hasPowerFields] */
function extractCtGridPower(ct) {
    let t = firstDefined(ct.TphasePw, ct.tPhasePw);
    let tn = firstDefined(ct.TnphasePw, ct.tnPhasePw);

    if (!t || t === 0) {
        const a = firstDefined(ct.AphasePw, ct.aPhasePw);
        const b = firstDefined(ct.BphasePw, ct.bPhasePw);
        const c = firstDefined(ct.CphasePw, ct.cPhasePw);
        if ([a, b, c].some(v => v !== undefined)) {
            t = safeFloat(a) + safeFloat(b) + safeFloat(c);
        }
    }
    if (!tn || tn === 0) {
        const a = firstDefined(ct.AnphasePw, ct.anPhasePw);
        const b = firstDefined(ct.BnphasePw, ct.bnPhasePw);
        const c = firstDefined(ct.CnphasePw, ct.cnPhasePw);
        if ([a, b, c].some(v => v !== undefined)) {
            tn = safeFloat(a) + safeFloat(b) + safeFloat(c);
        }
    }

    const hasFields = [t, tn].some(v => v !== null && v !== undefined);
    if (!hasFields) {
        return [0, 0, false];
    }
    return [safeFloat(t), safeFloat(tn), true];
}

function ctHasUsablePower(ct, gridBuy, gridSell, hasFields) {
    if (Math.abs(gridBuy) > 0 || Math.abs(gridSell) > 0) {
        return true;
    }
    if (!hasFields) {
        return false;
    }
    const comm = ct.commState;
    return comm === 1 || comm === '1' || comm === true;
}

function effectiveOngridNet(data, gridIn, gridOut, ongridCharge, ongridSupply, inGridSide, outGridSide) {
    const candidates = [];
    if (fieldPresent(data, 'gridInPw') || fieldPresent(data, 'gridOutPw')) {
        candidates.push(gridIn - gridOut);
    }
    if (fieldPresent(data, 'inOngridPw') || fieldPresent(data, 'outOngridPw')) {
        candidates.push(ongridCharge - ongridSupply);
    }
    if (fieldPresent(data, 'inGridSidePw') || fieldPresent(data, 'outGridSidePw')) {
        candidates.push(inGridSide - outGridSide);
    }
    return pickBestPowerNet(candidates);
}

/** @returns {[number, boolean]} */
function gridNetFromSystem(data, gridIn, gridOut, ongridCharge, ongridSupply, inGridSide, outGridSide) {
    const candidates = [];
    if (fieldPresent(data, 'inGridSidePw') || fieldPresent(data, 'outGridSidePw')) {
        candidates.push(inGridSide - outGridSide);
    }
    if (fieldPresent(data, 'gridInPw') || fieldPresent(data, 'gridOutPw')) {
        const diff = gridIn - gridOut;
        if (Math.abs(diff) > 0 || gridIn !== 0 || gridOut !== 0) {
            candidates.push(diff);
        }
    }
    if (fieldPresent(data, 'inOngridPw') || fieldPresent(data, 'outOngridPw')) {
        candidates.push(ongridCharge - ongridSupply);
    }
    if (!candidates.length) {
        return [0, false];
    }
    return [pickBestPowerNet(candidates), true];
}

function normalizePayloadFields(payload) {
    const result = { ...payload };
    if ((result.gridInPw === undefined || result.gridInPw === null) && result.gridBuyPw !== undefined && result.gridBuyPw !== null) {
        result.gridInPw = result.gridBuyPw;
    }
    if ((result.gridOutPw === undefined || result.gridOutPw === null) && result.gridSellPw !== undefined && result.gridSellPw !== null) {
        result.gridOutPw = result.gridSellPw;
    }
    if ((result.workMode === undefined || result.workMode === null) && result.workModel !== undefined && result.workModel !== null) {
        result.workMode = result.workModel;
    }
    return result;
}

function extractFlatBody(raw) {
    const metaKeys = new Set(['type', 'eventId', 'messageId', 'ts', 'deviceType', 'token', 'softver', 'body']);
    if (![...FLAT_PAYLOAD_KEYS].some(k => k in raw)) {
        return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!metaKeys.has(k)) {
            out[k] = v;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Sub-device helpers
// ---------------------------------------------------------------------------

function plugCommMode(item) {
    const val = item.commMode;
    if (val === undefined || val === null) {
        return null;
    }
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? null : n;
}

/** @returns {[boolean, string]} */
function plugMqttControlAllowed(item) {
    const mode = plugCommMode(item);
    if (mode === COMM_MODE_LOCAL) {
        return [true, ''];
    }
    if (mode === COMM_MODE_CLOUD) {
        return [false, 'Smart plug is cloud-connected (commMode=2) and cannot be controlled via MQTT. Please use the Jackery App.'];
    }
    if (mode === null) {
        return [false, 'Unknown commMode. MQTT control is only supported when commMode=1 (local).'];
    }
    return [false, `Smart plug commMode=${mode} does not support MQTT control. Only commMode=1 (local) is supported.`];
}

function subdeviceSn(item) {
    return pyOr(item.deviceSn, item.sn) || null;
}

function isCtItemDevType(devType) {
    return CT_ITEM_DEV_TYPES.has(devType);
}

function subdeviceSensorGroup(item, fromCtsArray = false) {
    if (fromCtsArray || isCtItemDevType(item.devType)) {
        return 'ct';
    }
    return 'plug';
}

function shouldCreatePlugSwitch(item) {
    return PLUG_ITEM_DEV_TYPES.has(item.devType);
}

function mergeSubdeviceList(existing, newItems) {
    const merged = new Map();
    for (const item of [...(existing || []), ...newItems]) {
        if (!isObj(item)) {
            continue;
        }
        const sn = subdeviceSn(item);
        if (!sn) {
            continue;
        }
        merged.set(sn, { ...(merged.get(sn) || {}), ...item });
    }
    return [...merged.values()];
}

function allSubdevicesFromCache(data, mainSn) {
    const result = [];
    const seen = new Set();
    if (mainSn) {
        seen.add(mainSn);
    }
    for (const key of ['plugs', 'plug', 'cts']) {
        const items = data[key];
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of items) {
            if (!isObj(item)) {
                continue;
            }
            const sn = subdeviceSn(item);
            if (!sn || seen.has(sn)) {
                continue;
            }
            seen.add(sn);
            result.push(item);
        }
    }
    return result;
}

function mergeSubdeviceArraysIntoCache(cache, body, mainSn) {
    let updated = false;
    const rawPlugs = pyOr(body.plug, body.plugs, body.socket, body.sockets);
    if (Array.isArray(rawPlugs) && rawPlugs.length) {
        const plugItems = [];
        for (const item of rawPlugs) {
            if (!isObj(item)) {
                continue;
            }
            const sn = subdeviceSn(item);
            if (sn && sn === mainSn) {
                continue;
            }
            const entry = { ...item };
            if (entry.devType === undefined || entry.devType === null) {
                entry.devType = 6;
            }
            plugItems.push(entry);
        }
        const existingPlugs = (cache.plugs || []).filter(p => isObj(p) && subdeviceSensorGroup(p) === 'plug');
        cache.plugs = mergeSubdeviceList(existingPlugs, plugItems);
        cache.plug = cache.plugs;
        updated = true;
    }

    const rawCts = pyOr(body.ct, body.cts);
    if (Array.isArray(rawCts) && rawCts.length) {
        const ctItems = [];
        for (const item of rawCts) {
            if (!isObj(item)) {
                continue;
            }
            const sn = subdeviceSn(item);
            if (sn && sn === mainSn) {
                continue;
            }
            ctItems.push({ ...item });
        }
        cache.cts = mergeSubdeviceList(cache.cts, ctItems);
        updated = true;
    }
    return updated;
}

function mergeSubdevicePointUpdate(cache, body, mainSn) {
    const deviceSn = subdeviceSn(body);
    if (!deviceSn || deviceSn === mainSn || deviceSn === 'system') {
        return false;
    }

    for (const key of ['plugs', 'plug', 'cts']) {
        const items = cache[key];
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of items) {
            if (isObj(item) && subdeviceSn(item) === deviceSn) {
                Object.assign(item, body);
                return true;
            }
        }
    }

    const entry = { ...body };
    let devType = entry.devType;
    if (devType === undefined || devType === null) {
        if (['switchSta', 'sysSwitch', 'outPw', 'inPw', 'totalEgy'].some(k => k in body)) {
            entry.devType = 6;
            devType = 6;
        } else if (['AphasePw', 'aPhasePw', 'phasePw', 'subType'].some(k => k in body)) {
            entry.devType = 3;
            devType = 3;
        }
    }

    if (PLUG_ITEM_DEV_TYPES.has(devType)) {
        cache.plugs = mergeSubdeviceList(cache.plugs, [entry]);
        cache.plug = cache.plugs;
        return true;
    }
    if (isCtItemDevType(devType)) {
        cache.cts = mergeSubdeviceList(cache.cts, [entry]);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Energy flow
// ---------------------------------------------------------------------------

/**
 * Energy flow calculation (App formulas). Mutates and returns `data`.
 */
function calculateEnergyFlow(data, log) {
    try {
        // 1. PV
        const pvVal = data.pvPw === undefined ? 0 : data.pvPw;
        const pv = isObj(pvVal) ? safeFloat(pyOr(pvVal.pvPw, pvVal.w, pvVal.power)) : safeFloat(pvVal);

        // 2. Grid-tied port
        const gridIn = safeFloat(data.gridInPw);
        const gridOut = safeFloat(data.gridOutPw);
        const ongridCharge = safeFloat(data.inOngridPw);
        const ongridSupply = safeFloat(data.outOngridPw);
        const inGridSide = safeFloat(data.inGridSidePw);
        const outGridSide = safeFloat(data.outGridSidePw);
        const pOng = effectiveOngridNet(data, gridIn, gridOut, ongridCharge, ongridSupply, inGridSide, outGridSide);

        // 3. AC socket
        const acIn = safeFloat(data.swEpsInPw);
        const acOut = safeFloat(data.swEpsOutPw);
        const pAc = acIn - acOut;
        const acSocket = acIn > 0 ? acIn : acOut;

        // 4. CT
        let gridAvailable = false;
        let gridBuy = 0;
        let gridSell = 0;
        let ctAvailable = false;
        const cts = data.cts;
        if (Array.isArray(cts) && cts.length > 0) {
            const ct = cts[0];
            let hasCtFields;
            [gridBuy, gridSell, hasCtFields] = extractCtGridPower(ct);
            if (ctHasUsablePower(ct, gridBuy, gridSell, hasCtFields)) {
                ctAvailable = true;
                gridAvailable = true;
            }
        }

        // 5. Net grid power
        let pGrid = 0;
        if (ctAvailable) {
            pGrid = gridBuy - gridSell;
            if (ongridCharge > 0 && gridBuy < ongridCharge && ongridCharge - gridBuy <= 50) {
                pGrid = pOng;
            } else if (Math.abs(pGrid) < 1 && Math.abs(pOng) > 1) {
                pGrid = pOng;
            }
        } else {
            [pGrid, gridAvailable] = gridNetFromSystem(data, gridIn, gridOut, ongridCharge, ongridSupply, inGridSide, outGridSide);
        }

        // 7. Battery
        const batIn = safeFloat(data.batInPw);
        const batOut = safeFloat(data.batOutPw);
        const hasSystemBat = fieldPresent(data, 'batInPw') || fieldPresent(data, 'batOutPw');
        let pBatt;
        let chg;
        let dischg;
        if (hasSystemBat) {
            pBatt = batIn - batOut;
            chg = batIn;
            dischg = batOut;
        } else {
            pBatt = pv + pAc + pOng;
            chg = Math.max(0, pBatt);
            dischg = Math.max(0, -pBatt);
        }

        // 8. Home load
        let pHome = 0;
        if (gridAvailable) {
            pHome = pGrid - pOng;
            if (ctAvailable) {
                if (gridBuy > 0 && ongridCharge > 0 && gridBuy < ongridCharge && ongridCharge - gridBuy <= 50) {
                    pHome = 0;
                } else if (gridBuy > 0 && ongridCharge > 0 && gridBuy < ongridCharge && ongridCharge - gridBuy > 50) {
                    pHome = ongridCharge - gridBuy;
                } else if (gridSell > 0 && ongridSupply > 0) {
                    pHome = gridSell - ongridSupply;
                } else if (gridSell > 0 && ongridCharge > 0) {
                    pHome = gridSell + ongridCharge;
                }
            }
        } else if (fieldPresent(data, 'outOngridPw') && ongridSupply > 0) {
            pHome = ongridSupply;
        }

        const otherLoad = safeFloat(data.otherLoadPw);
        if (pHome === 0 && fieldPresent(data, 'otherLoadPw') && otherLoad > 0) {
            pHome = otherLoad;
        }

        data.calc_ac_socket_power = acSocket;
        data.calc_home_power = pHome;
        data.calc_batt_net_power = pBatt;
        data.calc_battery_charge_power = chg;
        data.calc_battery_discharge_power = dischg;
        data.grid_available = gridAvailable;
        data.calc_grid_net_power = pGrid;
    } catch (e) {
        if (log) {
            log.error(`Error calculating energy flow: ${e.message}`);
        }
    }
    return data;
}

// ---------------------------------------------------------------------------
// Device core (one instance per SolarVault host)
// ---------------------------------------------------------------------------

class JackeryCore {
    /**
     * @param {object} opts
     * @param {string} opts.deviceSn host serial number
     * @param {object} [opts.log] logger with debug/info/warn/error
     * @param {() => number} [opts.now] clock in seconds (injectable for tests)
     */
    constructor({ deviceSn, log, now }) {
        this.deviceSn = deviceSn;
        this.log = log || { debug() {}, info() {}, warn() {}, error() {} };
        this.now = now || (() => Date.now() / 1000);

        this.cache = {};
        this.knownSubdevices = new Map(); // sn -> 'plug' | 'ct'
        this.subdeviceLastSeen = new Map();
        this.deviceType = null;
        this.softVer = null;
        this.startTime = this.now();
        this.lastUpdateTime = this.startTime;
        this.everReceived = false;
        this.reauthRaised = false;
    }

    /** Topic suffix (`status`/`event`) or null when the topic belongs to another device. */
    matchTopic(topic, prefix) {
        const base = `${prefix}/device/`;
        if (!topic.startsWith(base)) {
            return null;
        }
        const rest = topic.slice(base.length).split('/');
        if (rest.length < 2 || !['status', 'event'].includes(rest[1])) {
            return null;
        }
        return { sn: rest[0], kind: rest[1] };
    }

    recordSubdeviceSeen(sn) {
        if (sn && sn !== this.deviceSn && sn !== 'system') {
            this.subdeviceLastSeen.set(sn, this.now());
        }
    }

    mergeNormalized(payload) {
        Object.assign(this.cache, normalizePayloadFields(payload));
    }

    /**
     * Process a raw MQTT message for this device.
     * @param {string} payloadText raw JSON
     * @returns {{ok: boolean, metaChanged: boolean, reauth: string|null, removed: string[]}}
     */
    handleMessage(payloadText) {
        const result = { ok: false, metaChanged: false, reauth: null, removed: [] };

        // Brokers (e.g. the ioBroker MQTT server) replay the stored value of existing topics on subscribe;
        // for never-written topics that is an empty payload. Not a device message: ignore silently.
        if (typeof payloadText !== 'string' || !payloadText.trim()) {
            return result;
        }

        let raw;
        try {
            raw = JSON.parse(payloadText);
        } catch (e) {
            this.log.warn(`Invalid JSON payload for ${this.deviceSn}: ${payloadText.slice(0, 80)}`);
            return result;
        }
        if (!isObj(raw)) {
            return result;
        }

        // Only a valid device message counts as a heartbeat (offline and token detection depend on it).
        this.lastUpdateTime = this.now();
        this.everReceived = true;

        try {
            const msgCode = raw.type;
            let body = raw.body;

            const bodySn = isObj(body) ? body.deviceSn : null;
            const isMainDeviceMsg = !bodySn || bodySn === this.deviceSn || bodySn === 'system';
            if (isMainDeviceMsg && [2, 23, 25, 106, 107].includes(msgCode)) {
                result.metaChanged = this.captureDeviceMeta(raw, body);
            }

            if (body === null || body === undefined) {
                if (msgCode === 101) {
                    return { ...result, ok: true };
                }
                const flat = extractFlatBody(raw);
                body = truthy(flat) ? flat : {};
            }

            if (msgCode === 23 && isObj(body)) {
                const snInBody = body.deviceSn;
                if (!snInBody || snInBody === this.deviceSn || snInBody === 'system') {
                    this.mergeNormalized(body);
                } else {
                    this.recordSubdeviceSeen(snInBody);
                    for (const key of ['plugs', 'plug', 'cts']) {
                        const items = this.cache[key];
                        if (Array.isArray(items)) {
                            for (const item of items) {
                                if (item.sn === snInBody || item.deviceSn === snInBody) {
                                    Object.assign(item, body);
                                    break;
                                }
                            }
                        }
                    }
                }
            } else if (msgCode === 106 && isObj(body)) {
                this.log.debug(`type 106 system data for ${this.deviceSn} (${Object.keys(body).length} fields)`);
                this.mergeNormalized(body);
            } else if (msgCode === 107 && isObj(body)) {
                this.mergeNormalized(body);
            } else if (msgCode === 102 && isObj(body)) {
                this.recordSubdeviceSeen(subdeviceSn(body));
                if (!mergeSubdeviceArraysIntoCache(this.cache, body, this.deviceSn)) {
                    mergeSubdevicePointUpdate(this.cache, body, this.deviceSn);
                }
                for (const key of ['plugs', 'plug', 'cts']) {
                    for (const item of body[key] || []) {
                        if (isObj(item)) {
                            this.recordSubdeviceSeen(subdeviceSn(item));
                        }
                    }
                }
            } else if (msgCode === 101 && isObj(body)) {
                this.handleType101(body, result);
            } else if (msgCode === 123 && isObj(body)) {
                if (body.errorCode === 401) {
                    result.reauth = 'device reported token mismatch (123/401)';
                }
            } else if (isObj(body) && truthy(body)) {
                this.recordSubdeviceSeen(subdeviceSn(body));
                for (const key of ['plugs', 'plug', 'cts']) {
                    for (const item of body[key] || []) {
                        if (isObj(item)) {
                            this.recordSubdeviceSeen(subdeviceSn(item));
                        }
                    }
                }
                const subUpdated = mergeSubdeviceArraysIntoCache(this.cache, body, this.deviceSn);
                const pointUpdated = mergeSubdevicePointUpdate(this.cache, body, this.deviceSn);
                const skip = new Set(['plugs', 'plug', 'socket', 'sockets', 'cts', 'ct', 'deviceSn', 'sn']);
                const mainBody = {};
                for (const [k, v] of Object.entries(body)) {
                    if (!skip.has(k)) {
                        mainBody[k] = v;
                    }
                }
                if (truthy(mainBody) && !(pointUpdated && !subUpdated)) {
                    this.mergeNormalized(mainBody);
                } else if (!subUpdated && !pointUpdated) {
                    this.mergeNormalized(body);
                }
            }

            calculateEnergyFlow(this.cache, this.log);
            result.ok = true;
        } catch (e) {
            this.log.error(`Error handling message for ${this.deviceSn}: ${e.message}`);
        }
        return result;
    }

    handleType101(body, result) {
        const queryDevType = body.devType;
        const rawPlugs = pyOr(body.plug, body.plugs, body.socket, body.sockets, []);
        const rawCts = pyOr(body.ct, body.cts, []);

        const plugItems = [];
        if (Array.isArray(rawPlugs)) {
            for (const item of rawPlugs) {
                if (!isObj(item)) {
                    continue;
                }
                const sn = subdeviceSn(item);
                if (sn && sn === this.deviceSn) {
                    continue;
                }
                this.recordSubdeviceSeen(sn);
                const entry = { ...item };
                if (entry.devType === undefined || entry.devType === null) {
                    entry.devType = 6;
                }
                plugItems.push(entry);
            }
        }

        const ctItems = [];
        if (Array.isArray(rawCts)) {
            for (const item of rawCts) {
                if (!isObj(item)) {
                    continue;
                }
                const sn = subdeviceSn(item);
                if (sn && sn === this.deviceSn) {
                    continue;
                }
                this.recordSubdeviceSeen(sn);
                ctItems.push({ ...item });
            }
        }

        const existingPlugs = (this.cache.plugs || []).filter(p => isObj(p) && subdeviceSensorGroup(p) === 'plug');
        const existingCts = (this.cache.cts || []).filter(p => isObj(p));
        for (const p of this.cache.plugs || []) {
            if (
                isObj(p) &&
                isCtItemDevType(p.devType) &&
                subdeviceSn(p) &&
                !existingCts.some(c => subdeviceSn(c) === subdeviceSn(p))
            ) {
                existingCts.push(p);
            }
        }

        if (queryDevType === 6) {
            this.cache.plugs = plugItems;
            const reported = new Set(plugItems.map(subdeviceSn).filter(Boolean));
            for (const [sn, group] of [...this.knownSubdevices]) {
                if (group === 'plug' && !reported.has(sn)) {
                    this.forgetSubdevice(sn);
                    result.removed.push(sn);
                }
            }
        } else if (queryDevType === 2) {
            this.cache.cts = ctItems;
            const reported = new Set(ctItems.map(subdeviceSn).filter(Boolean));
            for (const [sn, group] of [...this.knownSubdevices]) {
                if (group === 'ct' && !reported.has(sn)) {
                    this.forgetSubdevice(sn);
                    result.removed.push(sn);
                }
            }
        } else {
            this.cache.plugs = mergeSubdeviceList(existingPlugs, plugItems);
            this.cache.cts = mergeSubdeviceList(existingCts, ctItems);
        }
        this.cache.plug = this.cache.plugs || [];
        if (!this.cache.cts) {
            this.cache.cts = [];
        }
        this.log.debug(
            `type=101 devType=${queryDevType}: plugs=${(this.cache.plugs || []).length} cts=${this.cache.cts.length}`,
        );
    }

    forgetSubdevice(sn) {
        this.knownSubdevices.delete(sn);
        this.subdeviceLastSeen.delete(sn);
    }

    /**
     * Detect new sub-devices and evaluate availability of known ones.
     * @returns {{newDevices: {sn: string, group: string, devType: number|undefined, item: object}[], availability: Map<string, boolean>}}
     */
    checkSubdevices() {
        const now = this.now();
        const availability = new Map();

        for (const sn of this.knownSubdevices.keys()) {
            const lastSeen = this.subdeviceLastSeen.get(sn) || 0;
            let available = now - lastSeen <= OFFLINE_TIMEOUT;
            if (lastSeen === 0 && now - this.startTime < OFFLINE_TIMEOUT) {
                available = true;
            }
            availability.set(sn, available);
        }

        const newDevices = [];
        const ctSns = new Set(
            (this.cache.cts || []).filter(isObj).map(subdeviceSn).filter(Boolean),
        );
        for (const item of allSubdevicesFromCache(this.cache, this.deviceSn)) {
            const sn = subdeviceSn(item);
            if (sn && !this.knownSubdevices.has(sn)) {
                const group = subdeviceSensorGroup(item, ctSns.has(sn));
                this.knownSubdevices.set(sn, group);
                this.subdeviceLastSeen.set(sn, now);
                availability.set(sn, true);
                newDevices.push({ sn, group, devType: item.devType, item });
            }
        }
        return { newDevices, availability };
    }

    /** @returns {boolean} true when the host has not reported for longer than OFFLINE_TIMEOUT */
    isOffline() {
        return this.now() - this.lastUpdateTime > OFFLINE_TIMEOUT;
    }

    /** Heuristic: never received anything for REAUTH_HINT_TIMEOUT seconds. */
    tokenLooksInvalid() {
        return !this.everReceived && this.now() - this.startTime > REAUTH_HINT_TIMEOUT;
    }

    captureDeviceMeta(raw, body) {
        let changed = false;
        const deviceType = raw.deviceType;
        if (deviceType !== undefined && deviceType !== null && deviceType !== this.deviceType) {
            this.deviceType = deviceType;
            changed = true;
        }
        let softVer = raw.softver;
        if ((softVer === undefined || softVer === null) && isObj(body)) {
            softVer = body.softver;
        }
        if (softVer !== undefined && softVer !== null && softVer !== this.softVer) {
            this.softVer = softVer;
            changed = true;
        }
        return changed;
    }

    get model() {
        return this.deviceType === null ? DEFAULT_MODEL : DEVICE_TYPE_MODEL_MAP[this.deviceType] || DEFAULT_MODEL;
    }

    findPlug(sn) {
        for (const key of ['plugs', 'plug']) {
            const items = this.cache[key];
            if (!Array.isArray(items)) {
                continue;
            }
            for (const item of items) {
                if (isObj(item) && subdeviceSn(item) === sn) {
                    return item;
                }
            }
        }
        return null;
    }

    applyPlugSwitchCache(sn, on) {
        const item = this.findPlug(sn);
        if (item) {
            item.sysSwitch = on ? 1 : 0;
            item.switchSta = on ? 1 : 0;
        }
    }
}

module.exports = {
    OFFLINE_TIMEOUT,
    REAUTH_HINT_TIMEOUT,
    CT_SUBTYPE_MAP,
    FUNC_ENABLE_BITS,
    COMM_MODE_LABELS,
    JackeryCore,
    calculateEnergyFlow,
    extractCtGridPower,
    normalizePayloadFields,
    extractFlatBody,
    plugCommMode,
    plugMqttControlAllowed,
    shouldCreatePlugSwitch,
    subdeviceSn,
    subdeviceSensorGroup,
    safeFloat,
    firstDefined,
    pyOr,
};
