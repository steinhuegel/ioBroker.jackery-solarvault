/*
 * Smoke test for main.js without ioBroker / network:
 * `@iobroker/adapter-core` and `mqtt` are replaced by in-memory fakes.
 */
const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');
const path = require('path');

// ---------------------------------------------------------------- fakes
const states = new Map(); // id -> {val, ack}
const objects = new Map();
const published = [];
let fakeClient;

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.subscribed = [];
    }
    subscribe(topics, opts, cb) {
        this.subscribed.push(...topics);
        cb && cb(null);
    }
    publish(topic, payload, opts, cb) {
        published.push({ topic, msg: JSON.parse(payload) });
        cb && cb(null);
    }
    end() {}
}
const fakeMqtt = {
    connect() {
        fakeClient = new FakeClient();
        return fakeClient;
    },
};

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.name = options.name;
        this.namespace = `${options.name}.0`;
        this.instance = 0;
        this.config = FakeAdapter.config;
        this.log = { silly() {}, debug() {}, info() {}, warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) };
        this.timers = [];
    }
    async setState(id, val, ack) {
        return this.setStateAsync(id, val, ack);
    }
    async setStateAsync(id, val, ack) {
        const full = id.startsWith(this.namespace) ? id : `${this.namespace}.${id}`;
        states.set(full, { val, ack });
    }
    async setStateChangedAsync(id, val, ack) {
        return this.setStateAsync(id, val, ack);
    }
    async extendObjectAsync(id, obj) {
        const full = `${this.namespace}.${id}`;
        objects.set(full, { ...(objects.get(full) || {}), ...obj, common: { ...((objects.get(full) || {}).common || {}), ...(obj.common || {}) } });
    }
    async delObjectAsync(id) {
        const full = `${this.namespace}.${id}`;
        const hit = [...objects.keys()].filter(k => k === full || k.startsWith(`${full}.`));
        if (!hit.length) {
            throw new Error('not found');
        }
        hit.forEach(k => objects.delete(k));
    }
    async getObjectAsync(id) {
        return objects.get(`${this.namespace}.${id}`) || null;
    }
    async subscribeStatesAsync() {}
    setInterval(fn, ms) {
        this.timers.push({ fn, ms });
        return this.timers.length;
    }
    clearInterval() {}
}
const warns = [];
const errors = [];

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    if (request === 'mqtt') {
        return fakeMqtt;
    }
    return origLoad.call(this, request, ...rest);
};

// ---------------------------------------------------------------- test
const SN = 'HS2C12600262HH4';
const NS = 'jackery-solarvault.0';
const S = id => states.get(`${NS}.${SN}.${id}`);
const tick = () => new Promise(r => setImmediate(r));

async function flush() {
    for (let i = 0; i < 20; i++) {
        await tick();
    }
}

(async () => {
    FakeAdapter.config = {
        mqttHost: '127.0.0.1',
        mqttPort: 1883,
        topicPrefix: 'hb',
        enableExtraControls: true,
        devices: [{ enabled: true, sn: SN, token: 'TOKEN123' }],
    };
    const create = require(path.join(__dirname, '..', 'main.js'));
    const adapter = create({});
    adapter.emit('ready');
    await flush();

    // objects
    assert.ok(objects.has(`${NS}.${SN}.battery.battery_soc`), 'battery_soc object');
    assert.ok(objects.has(`${NS}.${SN}.control.socChargeLimit`), 'control object');
    assert.strictEqual(objects.get(`${NS}.${SN}.control.socChargeLimit`).common.write, true);

    // connect -> subscribe + polls
    fakeClient.emit('connect');
    await flush();
    assert.deepStrictEqual(fakeClient.subscribed, [`hb/device/${SN}/status`, `hb/device/${SN}/event`, `hb/device/${SN}/alert`]);
    const types = published.map(p => p.msg.type);
    assert.deepStrictEqual(types, [25, 105, 2, 100, 100]);
    assert.ok(published.every(p => p.topic === `hb/device/${SN}/action` && p.msg.token === 'TOKEN123'));
    assert.deepStrictEqual(published[3].msg.body, { devType: 2 });
    assert.deepStrictEqual(published[4].msg.body, { devType: 6 });
    assert.strictEqual(states.get(`${NS}.info.connection`).val, true);

    // status message
    const send = (kind, obj) => fakeClient.emit('message', `hb/device/${SN}/${kind}`, Buffer.from(JSON.stringify(obj)));
    send('status', { type: 25, deviceType: 3, softver: '1.0.9', body: { batSoc: 85, pvPw: 400, batOutPw: 150, batInPw: 0, cellTemp: 255, stat: 4, pvEgy: 1234, swEps: 1, socChgLimit: 90, minSocChg: 60, maxSocChg: 100 } });
    await flush();
    assert.strictEqual(S('battery.battery_soc').val, 85);
    assert.strictEqual(S('battery.battery_soc').ack, true);
    assert.strictEqual(S('solar.solar_power').val, 400);
    assert.strictEqual(S('solar.solar_energy').val, 12.34);
    assert.strictEqual(S('battery.battery_temperature').val, 25.5);
    assert.strictEqual(S('status.device_status').val, 4);
    assert.strictEqual(S('calc.calc_batt_net_power').val, -150);
    assert.strictEqual(S('control.acSocketSwitch').val, true);
    assert.strictEqual(S('control.socChargeLimit').val, 90);
    assert.strictEqual(S('info.available').val, true);
    assert.strictEqual(S('info.model').val, 'DIY3');
    assert.strictEqual(S('info.softver').val, '1.0.9');
    assert.strictEqual(objects.get(`${NS}.${SN}.control.socChargeLimit`).common.min, 60);

    // sub-devices
    send('event', { type: 101, body: { devType: 6, plugs: [{ deviceSn: 'PLUG1', commMode: 1, switchSta: 0, outPw: 12, totalEgy: 250 }] } });
    send('event', { type: 101, body: { devType: 2, cts: [{ deviceSn: 'CT1', devType: 3, subType: 2, commState: 1, TphasePw: 500, TnphasePw: 0, AphasePw: 200 }] } });
    await flush();
    assert.strictEqual(S('plug_PLUG1.power').val, 12);
    assert.strictEqual(S('plug_PLUG1.energy').val, 2.5);
    assert.strictEqual(S('plug_PLUG1.switch').val, false);
    assert.strictEqual(S('plug_PLUG1.mqttControllable').val, true);
    assert.strictEqual(S('ct_CT1.power_total_forward').val, 500);
    assert.strictEqual(S('ct_CT1.power_a_forward').val, 200);
    assert.strictEqual(S('calc.calc_grid_net_power').val, 500);
    assert.strictEqual(objects.get(`${NS}.${SN}.plug_PLUG1.switch`).common.write, true);

    // commands
    published.length = 0;
    await adapter.onStateChange(`${NS}.${SN}.control.socChargeLimit`, { val: 200, ack: false });
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].msg.type, 1);
    assert.strictEqual(published[0].msg.eventId, 3);
    assert.deepStrictEqual(published[0].msg.body, { cmd: 5, rc: 1, socChgLimit: 100 }); // clamped to max
    assert.strictEqual(published[0].msg.token, 'TOKEN123');

    await adapter.onStateChange(`${NS}.${SN}.control.acSocketSwitch`, { val: false, ack: false });
    assert.deepStrictEqual(published[1].msg.body, { cmd: 5, rc: 1, swEps: 0 });

    await adapter.onStateChange(`${NS}.${SN}.control.autoStandbyMode`, { val: 7, ack: false });
    assert.strictEqual(published.length, 2, 'invalid enum value not sent');

    await adapter.onStateChange(`${NS}.${SN}.control.reboot`, { val: true, ack: false });
    assert.deepStrictEqual(published[2].msg.body, { cmd: 5, rc: 1, reboot: 1 });

    await adapter.onStateChange(`${NS}.${SN}.plug_PLUG1.switch`, { val: true, ack: false });
    const p103 = published[3].msg;
    assert.strictEqual(p103.type, 103);
    assert.deepStrictEqual(p103.body, { deviceSn: 'PLUG1', devType: 6, sysSwitch: 1 });
    assert.strictEqual(S('plug_PLUG1.switch').val, true);

    // acknowledged writes are ignored
    const before = published.length;
    await adapter.onStateChange(`${NS}.${SN}.control.acSocketSwitch`, { val: true, ack: true });
    assert.strictEqual(published.length, before);

    // cloud plug is blocked
    send('event', { type: 102, body: { deviceSn: 'PLUG1', commMode: 2 } });
    await flush();
    await adapter.onStateChange(`${NS}.${SN}.plug_PLUG1.switch`, { val: false, ack: false });
    assert.strictEqual(published.length, before, 'cloud plug not controlled via MQTT');
    assert.ok(warns.some(w => w.includes('blocked')));

    // unbound plug removes objects
    send('event', { type: 101, body: { devType: 6, plugs: [] } });
    await flush();
    assert.ok(![...objects.keys()].some(k => k.includes('plug_PLUG1')), 'plug objects removed');

    // expansion battery
    send('status', { type: 23, body: { deviceSn: 'BP1', devType: 1, subType: 0, inEgy: 1234, outEgy: 567 } });
    await flush();
    assert.strictEqual(S('exp_BP1.charge_energy').val, 12.34);
    assert.strictEqual(S('exp_BP1.discharge_energy').val, 5.67);
    assert.strictEqual(S('exp_BP1.available').val, true);

    // additional read-only values and extra controls
    send('status', { type: 106, body: { workModel: 4, defaultPw: 100, maxFeedGrid: 800, isFollowMeterPw: 1, stackInPw: 5, batState: 2 } });
    await flush();
    assert.strictEqual(S('settings.default_output_power').val, 100);
    assert.strictEqual(S('settings.follow_meter').val, true);
    assert.strictEqual(S('battery.stack_in_power').val, 5);
    assert.strictEqual(S('control.workMode').val, 4);
    assert.strictEqual(S('control.maxFeedGrid').val, 800);
    published.length = 0;
    await adapter.onStateChange(`${NS}.${SN}.control.workMode`, { val: 7, ack: false });
    assert.deepStrictEqual(published[0].msg.body, { cmd: 5, rc: 1, workModel: 7 });
    await adapter.onStateChange(`${NS}.${SN}.control.workMode`, { val: 5, ack: false });
    assert.strictEqual(published.length, 1, 'invalid work mode not sent');
    await adapter.onStateChange(`${NS}.${SN}.control.defaultOutputPower`, { val: 155, ack: false });
    assert.deepStrictEqual(published[1].msg.body, { cmd: 5, rc: 1, defaultPw: 160 }); // 10 W steps
    await adapter.onStateChange(`${NS}.${SN}.control.defaultOutputPower`, { val: 999, ack: false });
    assert.deepStrictEqual(published[2].msg.body, { cmd: 5, rc: 1, defaultPw: 200 }); // clamped
    await adapter.onStateChange(`${NS}.${SN}.control.forceCharge`, { val: true, ack: false });
    assert.deepStrictEqual(published[3].msg.body, { cmd: 5, rc: 1, socForceChg: 1 });

    // meter reader (EcoTracker)
    send('event', { type: 101, body: { cmd: 110, devType: 2, cts: [], collectors: [{ deviceSn: 'ECO1', devType: 4, subType: 1, commState: 1, scanName: 'ecotracker', wip: '192.168.1.2', outPw: 0, inPw: 345 }] } });
    await flush();
    assert.strictEqual(S('collector_ECO1.name').val, 'ecotracker');
    assert.strictEqual(S('collector_ECO1.import_power').val, 345);
    assert.strictEqual(S('collector_ECO1.connected').val, true);
    assert.strictEqual(S('collector_ECO1.available').val, true);

    // network values, 10 W steps for maxOutputPower
    send('status', { type: 106, body: { ethPort: 1, wsig: -61, wname: 'MeinWLAN', wip: '192.168.178.50', eip: '', maxInvStdPw: 30, inCtEgy: 1234 } });
    await flush();
    assert.strictEqual(S('network.ethernet_connected').val, true);
    assert.strictEqual(S('network.wifi_signal').val, -61);
    assert.strictEqual(S('network.wifi_ssid').val, 'MeinWLAN');
    assert.strictEqual(S('network.ethernet_ip').val, '');
    assert.strictEqual(S('settings.max_inverter_standby_power').val, 30);
    assert.strictEqual(S('energy.ct_import_energy').val, 12.34);
    await adapter.onStateChange(`${NS}.${SN}.control.maxOutputPower`, { val: 455, ack: false });
    assert.strictEqual(published[published.length - 1].msg.body.maxOutPw, 460);

    // raw logging is masked
    adapter.config.logRawMessages = true;
    const infoLog = [];
    const origInfo = adapter.log.info;
    adapter.log.info = (m) => { infoLog.push(m); };
    send('status', { type: 2, token: '12345678', body: { wname: 'Geheim', eip: '192.168.1.5', emac: 'AA:BB', deviceSn: SN } });
    await flush();
    adapter.log.info = origInfo;
    adapter.config.logRawMessages = false;
    const rawLine = infoLog.find((l) => l.startsWith('RAW status'));
    assert.ok(rawLine, 'raw line logged');
    assert.ok(!rawLine.includes('12345678') && !rawLine.includes('Geheim') && !rawLine.includes('192.168.1.5') && !rawLine.includes('AA:BB') && !rawLine.includes(SN), rawLine);

    // alert
    fakeClient.emit('message', `hb/device/${SN}/alert`, Buffer.from(JSON.stringify({ body: { alertId: 42, recordTs: 1700000000 } })));
    await flush();
    assert.strictEqual(S('alert.alertId').val, 42);
    assert.strictEqual(S('alert.trigger').val, true);
    assert.ok(JSON.parse(S('alert.json').val).alertId === 42);

    // messages for other devices are ignored
    const nBefore = states.size;
    fakeClient.emit('message', 'hb/device/OTHER/status', Buffer.from(JSON.stringify({ batSoc: 1 })));
    await flush();
    assert.strictEqual(states.size, nBefore);

    // periodic poll timer registered
    assert.strictEqual(adapter.timers[0].ms, 5000);
    published.length = 0;
    adapter.timers[0].fn();
    await flush();
    assert.strictEqual(published.length, 5);

    assert.deepStrictEqual(errors, [], `unexpected errors: ${errors.join('; ')}`);
    console.log('main.js smoke test passed');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
