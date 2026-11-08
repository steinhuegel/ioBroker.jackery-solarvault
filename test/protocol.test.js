const assert = require('assert');
const {
    JackeryCore,
    calculateEnergyFlow,
    extractCtGridPower,
    plugMqttControlAllowed,
} = require('../lib/protocol');

let t = 1700000000;
const clock = () => t;
const SN = 'HS2C12600262HH4';
const mk = () => new JackeryCore({ deviceSn: SN, now: clock });
const msg = obj => JSON.stringify(obj);
let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`ok  ${name}`);
}

test('type 25 flat host status merges into cache and computes energy flow', () => {
    const c = mk();
    const r = c.handleMessage(msg({ type: 25, deviceType: 3, softver: '1.2.3', body: { batSoc: 85, pvPw: 400, batOutPw: 150, batInPw: 0, cellTemp: 255 } }));
    assert.ok(r.ok);
    assert.ok(r.metaChanged);
    assert.strictEqual(c.model, 'DIY3');
    assert.strictEqual(c.softVer, '1.2.3');
    assert.strictEqual(c.cache.batSoc, 85);
    assert.strictEqual(c.cache.calc_batt_net_power, -150);
    assert.strictEqual(c.cache.calc_battery_discharge_power, 150);
});

test('flat status message without type/body wrapper', () => {
    const c = mk();
    c.handleMessage(msg({ batSoc: 50, pvPw: 100, swEpsInPw: 0, swEpsOutPw: 30 }));
    assert.strictEqual(c.cache.batSoc, 50);
    assert.strictEqual(c.cache.calc_ac_socket_power, 30);
});

test('type 107 incremental soc/workMode', () => {
    const c = mk();
    c.handleMessage(msg({ type: 107, deviceType: 3, body: { soc: 12, workModel: 3 } }));
    assert.strictEqual(c.cache.soc, 12);
    assert.strictEqual(c.cache.workMode, 3);
});

test('type 106 alias gridBuyPw -> gridInPw and grid net power', () => {
    const c = mk();
    c.handleMessage(msg({ type: 106, body: { gridBuyPw: 300, gridSellPw: 0, otherLoadPw: 0 } }));
    assert.strictEqual(c.cache.gridInPw, 300);
    assert.strictEqual(c.cache.calc_grid_net_power, 300);
    assert.strictEqual(c.cache.grid_available, true);
});

test('CT total power falls back to phase sum', () => {
    const [buy, sell, has] = extractCtGridPower({ AphasePw: 100, BphasePw: 50, CphasePw: 25, TnphasePw: 0, AnphasePw: 0 });
    assert.strictEqual(buy, 175);
    assert.strictEqual(sell, 0);
    assert.ok(has);
});

test('type 101 discovers CT and plug; availability and removal', () => {
    const c = mk();
    c.handleMessage(msg({ type: 101, body: { devType: 6, plugs: [{ deviceSn: 'PLUG1', commMode: 1, switchSta: 1, outPw: 42 }] } }));
    c.handleMessage(msg({ type: 101, body: { devType: 2, cts: [{ deviceSn: 'CT1', devType: 3, subType: 2, commState: 1, TphasePw: 500, TnphasePw: 0 }] } }));
    let res = c.checkSubdevices();
    assert.deepStrictEqual(res.newDevices.map(d => `${d.group}:${d.sn}`).sort(), ['ct:CT1', 'plug:PLUG1']);
    assert.strictEqual(c.cache.calc_grid_net_power, 500);
    assert.strictEqual(c.findPlug('PLUG1').outPw, 42);

    // offline detection for a sub-device
    t += 61;
    res = c.checkSubdevices();
    assert.strictEqual(res.availability.get('PLUG1'), false);
    c.handleMessage(msg({ type: 102, body: { deviceSn: 'PLUG1', outPw: 60 } }));
    res = c.checkSubdevices();
    assert.strictEqual(res.availability.get('PLUG1'), true);
    assert.strictEqual(c.findPlug('PLUG1').outPw, 60);

    // plug unbound -> missing from next full plug report
    const r = c.handleMessage(msg({ type: 101, body: { devType: 6, plugs: [] } }));
    assert.deepStrictEqual(r.removed, ['PLUG1']);
    assert.ok(!c.knownSubdevices.has('PLUG1'));
    assert.ok(c.knownSubdevices.has('CT1'));
});

test('first type 101 for plugs before any CT does not throw (HA KeyError bug not ported)', () => {
    const c = mk();
    const r = c.handleMessage(msg({ type: 101, body: { devType: 6, plugs: [{ deviceSn: 'P', commMode: 2 }] } }));
    assert.ok(r.ok);
    assert.deepStrictEqual(c.cache.cts, []);
});

test('plug control gating by commMode', () => {
    assert.strictEqual(plugMqttControlAllowed({ commMode: 1 })[0], true);
    assert.strictEqual(plugMqttControlAllowed({ commMode: 2 })[0], false);
    assert.strictEqual(plugMqttControlAllowed({})[0], false);
});

test('type 123 errorCode 401 requests reauth', () => {
    const c = mk();
    const r = c.handleMessage(msg({ type: 123, body: { errorCode: 401 } }));
    assert.ok(r.reauth);
});

test('offline + token heuristics', () => {
    const c = mk();
    assert.strictEqual(c.isOffline(), false);
    t += 61;
    assert.strictEqual(c.isOffline(), true);
    assert.strictEqual(c.tokenLooksInvalid(), false);
    t += 60;
    assert.strictEqual(c.tokenLooksInvalid(), true);
    c.handleMessage(msg({ type: 25, body: { batSoc: 1 } }));
    assert.strictEqual(c.tokenLooksInvalid(), false);
    assert.strictEqual(c.isOffline(), false);
});

test('invalid JSON is ignored', () => {
    const c = mk();
    assert.strictEqual(c.handleMessage('{oops').ok, false);
});

test('type 23 statistics from other device go to sub-device, host stats to cache', () => {
    const c = mk();
    c.handleMessage(msg({ type: 23, body: { pvEgy: 1234 } }));
    assert.strictEqual(c.cache.pvEgy, 1234);
    c.handleMessage(msg({ type: 101, body: { devType: 6, plugs: [{ deviceSn: 'PX', commMode: 1 }] } }));
    c.handleMessage(msg({ type: 23, body: { deviceSn: 'PX', totalEgy: 555 } }));
    assert.strictEqual(c.findPlug('PX').totalEgy, 555);
    assert.strictEqual(c.cache.totalEgy, undefined);
});

test('energy flow: battery formula without system battery fields', () => {
    const d = calculateEnergyFlow({ pvPw: 400, swEpsInPw: 0, swEpsOutPw: 100, inOngridPw: 0, outOngridPw: 200 });
    // pv + ac + ong = 400 + (0-100) + (0-200) = 100
    assert.strictEqual(d.calc_batt_net_power, 100);
    assert.strictEqual(d.calc_battery_charge_power, 100);
});

test('ongrid net: type-2 fields win over stale type-106 grid values (standby)', () => {
    const d = calculateEnergyFlow({ inOngridPw: 0, outOngridPw: 0, gridInPw: 250, gridOutPw: 0, otherLoadPw: 0 });
    // stale gridInPw must not be used as ongrid power: home load = 250 W from the grid instead of collapsing to 0
    assert.strictEqual(d.calc_home_power, 250);
});

test('home power may be negative (surplus from another PV system)', () => {
    const f = calculateEnergyFlow({ inOngridPw: 0, outOngridPw: 0, gridInPw: 0, gridOutPw: 400 });
    assert.strictEqual(f.calc_home_power, -400);
});

test('type 23 devType 1 is an expansion battery (BP2500), not a host or plug', () => {
    const c = mk();
    c.handleMessage(msg({ type: 23, body: { pvEgy: 100 } }));
    c.handleMessage(msg({ type: 23, body: { deviceSn: 'BP1', devType: 1, subType: 0, inEgy: 1234, outEgy: 567 } }));
    assert.strictEqual(c.cache.inEgy, undefined);
    assert.strictEqual(c.expansionBatteries.get('BP1').inEgy, 1234);
    assert.strictEqual(c.cache.pvEgy, 100);
    let r = c.checkExpansionBatteries();
    assert.deepStrictEqual(r.newBatteries, ['BP1']);
    assert.strictEqual(r.availability.get('BP1'), true);
    // null values do not overwrite real values; sn-only payload works
    c.handleMessage(msg({ type: 23, body: { sn: 'BP1', devType: 1, inEgy: null, outEgy: 600 } }));
    assert.strictEqual(c.expansionBatteries.get('BP1').inEgy, 1234);
    assert.strictEqual(c.expansionBatteries.get('BP1').outEgy, 600);
    r = c.checkExpansionBatteries();
    assert.deepStrictEqual(r.newBatteries, []);
    // 10 min later still available, after 31 min not
    t += 600;
    assert.strictEqual(c.checkExpansionBatteries().availability.get('BP1'), true);
    t += 1300;
    assert.strictEqual(c.checkExpansionBatteries().availability.get('BP1'), false);
});

test('alert topic parsing (wrapped and flat, invalid ignored)', () => {
    const c = mk();
    assert.strictEqual(c.matchTopic('hb/device/X/alert', 'hb').kind, 'alert');
    const a = c.handleAlert(msg({ body: { alertId: 42, recordTs: 1700000000, status: 1, startTs: 5 } }));
    assert.strictEqual(a.alertId, 42);
    assert.strictEqual(a.recordTs, 1700000000);
    assert.deepStrictEqual(a.extra, { status: 1, startTs: 5 });
    assert.strictEqual(c.handleAlert(msg({ alertId: 7 })).alertId, 7);
    assert.strictEqual(c.handleAlert(''), null);
    assert.strictEqual(c.handleAlert('{oops'), null);
});

console.log(`\n${passed} tests passed`);
