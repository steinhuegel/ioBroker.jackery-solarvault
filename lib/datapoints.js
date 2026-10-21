'use strict';

/**
 * Data point definitions for the SolarVault 3 host.
 * Mirrors the SENSORS / NUMBERS / switch definitions of the official Home Assistant integration.
 *
 * key    : JSON field in the device message (cache key)
 * scale  : multiplier applied to the raw value (energy 0.01 -> kWh, cellTemp 0.1 -> °C)
 */

const P = 'W';
const E = 'kWh';

/** @type {Record<string, object>} read-only sensors, id -> definition (id becomes `<group>.<id>`) */
const SENSORS = {
    // status
    device_status: { group: 'status', key: 'stat', name: 'Status', type: 'number', role: 'value', states: { 0: 'normal', 1: 'waiting', 2: 'alarm', 3: 'fault', 4: 'standby', 5: 'low_power' } },
    work_mode: { group: 'status', key: 'workMode', name: 'Work Mode', type: 'number', role: 'value' },
    ongrid_status: { group: 'status', key: 'ongridStat', name: 'OnGrid Status', type: 'number', role: 'value', states: { 0: 'off_grid', 1: 'on_grid' } },
    ct_status: { group: 'status', key: 'ctStat', name: 'CT Status', type: 'number', role: 'value', states: { 0: 'offline', 1: 'online' } },
    grid_meter_link: { group: 'status', key: 'gridSate', name: 'Grid Meter Link', type: 'number', role: 'value', states: { 0: 'abnormal', 1: 'normal' } },
    eps_state: { group: 'status', key: 'swEpsState', name: 'AC Socket Status (1=normal, 0=abnormal)', type: 'number', role: 'value' },

    // battery
    battery_soc: { group: 'battery', key: 'batSoc', name: 'Battery SOC', type: 'number', role: 'value.battery', unit: '%', int: true },
    average_soc: { group: 'battery', key: 'soc', name: 'Average SOC', type: 'number', role: 'value.battery', unit: '%', int: true },
    battery_charge_power: { group: 'battery', key: 'batInPw', name: 'Battery Charge Power', type: 'number', role: 'value.power', unit: P },
    battery_discharge_power: { group: 'battery', key: 'batOutPw', name: 'Battery Discharge Power', type: 'number', role: 'value.power', unit: P },
    battery_temperature: { group: 'battery', key: 'cellTemp', name: 'Battery Temperature', type: 'number', role: 'value.temperature', unit: '°C', scale: 0.1 },
    battery_count: { group: 'battery', key: 'batNum', name: 'Battery Count', type: 'number', role: 'value', int: true },
    battery_charge_energy: { group: 'battery', key: 'batChgEgy', name: 'Battery Charge Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    battery_discharge_energy: { group: 'battery', key: 'batDisChgEgy', name: 'Battery Discharge Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },

    // solar
    solar_power: { group: 'solar', key: 'pvPw', name: 'Solar Power', type: 'number', role: 'value.power', unit: P },
    solar_energy: { group: 'solar', key: 'pvEgy', name: 'Solar Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    solar_power_pv1: { group: 'solar', key: 'pv1', name: 'Solar Power PV1', type: 'number', role: 'value.power', unit: P },
    solar_energy_pv1: { group: 'solar', key: 'pv1Egy', name: 'Solar Energy PV1', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    solar_power_pv2: { group: 'solar', key: 'pv2', name: 'Solar Power PV2', type: 'number', role: 'value.power', unit: P },
    solar_energy_pv2: { group: 'solar', key: 'pv2Egy', name: 'Solar Energy PV2', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    solar_power_pv3: { group: 'solar', key: 'pv3', name: 'Solar Power PV3', type: 'number', role: 'value.power', unit: P },
    solar_energy_pv3: { group: 'solar', key: 'pv3Egy', name: 'Solar Energy PV3', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    solar_power_pv4: { group: 'solar', key: 'pv4', name: 'Solar Power PV4', type: 'number', role: 'value.power', unit: P },
    solar_energy_pv4: { group: 'solar', key: 'pv4Egy', name: 'Solar Energy PV4', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },

    // grid
    grid_import_power: { group: 'grid', key: 'gridInPw', name: 'Grid Port Input Power', type: 'number', role: 'value.power', unit: P },
    grid_import_energy: { group: 'grid', key: 'inOngridEgy', name: 'Grid Port Input Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    grid_export_power: { group: 'grid', key: 'gridOutPw', name: 'Grid Port Output Power', type: 'number', role: 'value.power', unit: P },
    grid_export_energy: { group: 'grid', key: 'outOngridEgy', name: 'Grid Port Output Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    other_load_power: { group: 'grid', key: 'otherLoadPw', name: 'Other Load Power', type: 'number', role: 'value.power', unit: P },
    max_feed_grid_power: { group: 'grid', key: 'maxFeedGrid', name: 'Max Feed-in Grid Power', type: 'number', role: 'value.power', unit: P },

    // AC socket (EPS)
    eps_input_power: { group: 'ac_socket', key: 'swEpsInPw', name: 'AC Socket Input Power', type: 'number', role: 'value.power', unit: P },
    eps_input_energy: { group: 'ac_socket', key: 'inEpsEgy', name: 'AC Socket Input Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    eps_output_energy: { group: 'ac_socket', key: 'outEpsEgy', name: 'AC Socket Output Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },

    // energy flow statistics
    ac_to_battery_energy: { group: 'energy', key: 'acOtBatEgy', name: 'AC Socket to Battery Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    pv_to_battery_energy: { group: 'energy', key: 'pvOtBatEgy', name: 'PV to Battery Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    pv_to_ac_energy: { group: 'energy', key: 'pvOtAcEgy', name: 'PV to AC Socket Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    pv_to_grid_energy: { group: 'energy', key: 'pvOtOngridEgy', name: 'PV to Grid Port Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    grid_to_ac_load_energy: { group: 'energy', key: 'ongridOtAcLoadEgy', name: 'Grid Port to AC Socket Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    battery_to_ac_energy: { group: 'energy', key: 'batOtAcEgy', name: 'Battery to AC Socket Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    battery_to_grid_energy: { group: 'energy', key: 'batOtGridEgy', name: 'Battery to Grid Port Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    grid_to_battery_energy: { group: 'energy', key: 'ongridOtBatEgy', name: 'Grid Port to Battery Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    ac_to_grid_energy: { group: 'energy', key: 'acOtOngridEgy', name: 'AC Socket to Grid Port Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },

    // calculated by the adapter (Jackery app formulas)
    calc_grid_net_power: { group: 'calc', key: 'calc_grid_net_power', name: 'Grid Net Power (+import / -export)', type: 'number', role: 'value.power', unit: P },
    calc_home_power: { group: 'calc', key: 'calc_home_power', name: 'Home Power', type: 'number', role: 'value.power', unit: P },
    calc_ac_socket_power: { group: 'calc', key: 'calc_ac_socket_power', name: 'AC Socket Power', type: 'number', role: 'value.power', unit: P },
    calc_batt_net_power: { group: 'calc', key: 'calc_batt_net_power', name: 'Battery Net Power (+charge / -discharge)', type: 'number', role: 'value.power', unit: P },
    calc_battery_charge_power: { group: 'calc', key: 'calc_battery_charge_power', name: 'Battery Charge Power (calculated)', type: 'number', role: 'value.power', unit: P },
    calc_battery_discharge_power: { group: 'calc', key: 'calc_battery_discharge_power', name: 'Battery Discharge Power (calculated)', type: 'number', role: 'value.power', unit: P },
    grid_available: { group: 'calc', key: 'grid_available', name: 'Grid Data Available', type: 'boolean', role: 'indicator' },
};

/**
 * Writable controls (device command type=1, cmd=5).
 * These replace the sensor + switch/number/select pairs of the HA integration.
 */
const CONTROLS = {
    acSocketSwitch: { key: 'swEps', name: 'AC Socket Switch', type: 'boolean', role: 'switch', param: 'swEps', bool: true },
    autoStandbyAllowed: { key: 'isAutoStandby', name: 'Auto Standby Allowed', type: 'boolean', role: 'switch', param: 'isAutoStandby', bool: true },
    autoStandbyMode: { key: 'autoStandby', name: 'Auto Standby Mode', type: 'number', role: 'level', param: 'autoStandby', states: { 0: 'invalid', 1: 'standby', 2: 'on' } },
    socChargeLimit: { key: 'socChgLimit', name: 'SOC Charge Limit', type: 'number', role: 'level', unit: '%', min: 50, max: 100, param: 'socChgLimit', minKey: 'minSocChg', maxKey: 'maxSocChg' },
    socDischargeLimit: { key: 'socDischgLimit', name: 'SOC Discharge Limit', type: 'number', role: 'level', unit: '%', min: 5, max: 49, param: 'socDischgLimit', minKey: 'minSocDischg', maxKey: 'maxSocDischg' },
    maxOutputPower: { key: 'maxOutPw', name: 'Max Output Power (OnGrid)', type: 'number', role: 'level', unit: P, min: 0, max: 2500, param: 'maxOutPw' },
};

/** Sub-device (child) states */
const PLUG_STATES = {
    power: { key: 'outPw', altKey: 'power', name: 'Power', type: 'number', role: 'value.power', unit: P },
    energy: { key: 'totalEgy', name: 'Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
};

const CT_STATES = {
    power_total_forward: { name: 'CT Total Forward Power', type: 'number', role: 'value.power', unit: P },
    power_a_forward: { keys: ['AphasePw', 'aPhasePw'], name: 'CT Phase A Forward Power', type: 'number', role: 'value.power', unit: P },
    power_b_forward: { keys: ['BphasePw', 'bPhasePw'], name: 'CT Phase B Forward Power', type: 'number', role: 'value.power', unit: P },
    power_c_forward: { keys: ['CphasePw', 'cPhasePw'], name: 'CT Phase C Forward Power', type: 'number', role: 'value.power', unit: P },
    power_total_reverse: { name: 'CT Total Reverse Power', type: 'number', role: 'value.power', unit: P },
    power_a_reverse: { keys: ['AnphasePw', 'anPhasePw'], name: 'CT Phase A Reverse Power', type: 'number', role: 'value.power', unit: P },
    power_b_reverse: { keys: ['BnphasePw', 'bnPhasePw'], name: 'CT Phase B Reverse Power', type: 'number', role: 'value.power', unit: P },
    power_c_reverse: { keys: ['CnphasePw', 'cnPhasePw'], name: 'CT Phase C Reverse Power', type: 'number', role: 'value.power', unit: P },
    energy_forward: { keys: ['TphaseEgy', 'tPhaseEgy'], name: 'CT Forward Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
    energy_reverse: { keys: ['TnphaseEgy', 'tnPhaseEgy'], name: 'CT Reverse Energy', type: 'number', role: 'value.energy', unit: E, scale: 0.01 },
};

module.exports = { SENSORS, CONTROLS, PLUG_STATES, CT_STATES };
