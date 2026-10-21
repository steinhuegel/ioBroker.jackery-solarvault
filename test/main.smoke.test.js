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
    assert.deepStrictEqual(fakeClient.subscribed, [`hb/device/${SN}/status`, `hb/device/${SN}/event`]);
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
