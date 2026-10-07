// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常、数值在量程内
function isCounted(reading, device, settings) {
  return true;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
function effectiveConcentration(reading, settings) {
  return Number(reading.value);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return Number(reading.value) >= 0 && !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const counted = isCounted(row, device, settings);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, row),
      flow: flowAt(data, row),
      counted,
      concentration: counted ? effectiveConcentration(row, settings) : 0,
    };
  });
}

// 日均：按小时流量加权；有效小时不足 18 小时该日无效；补算小时不超过上限
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  if (!counted.length) {
    return { day, outletId, metric, rows, countedHours: 0, imputedHours: 0, average: 0, valid: false, limit, exceed: false, flowTotal: 0 };
  }
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = store.round(sum / counted.length, 2);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours: counted.filter((r) => r.source === '补录').length,
    average,
    valid: true,
    limit,
    exceed: average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有数据的天平均
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  const days = store.daysInMonth(month);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / days, 2);
}

// —— 排放量量纲（全系统只有这一处换算，月总量、季度总量、年累计都从这里过）——
// 每小时排放量(吨) = 折算浓度(mg/L) × 流量(m³/h) × 1000(L/m³) ÷ tonsDivisor(mg/吨，默认 1e9)
// 量纲链：mg/L × m³/h 得到的是「每立方米水在某小时内含多少毫克」的乘积，单位是 mg·m³/(L·h)，
// 必须乘 1000 L/m³ 把升折算成立方米才得到 mg/h，再除以 1e9 mg/吨 得到 吨/h。
// 漏掉 ×1000 这一步，结果会小三个数量级（2026-10 前就是这么错的）。
const LITERS_PER_CUBIC_METER = 1000; // 1 m³ = 1000 L，物理常数

function hourlyEmissionTons(concentrationMgPerL, flowM3PerHour, settings) {
  const mgPerHour = Number(concentrationMgPerL) * Number(flowM3PerHour) * LITERS_PER_CUBIC_METER;
  return mgPerHour / Number(settings.tonsDivisor);
}

// 逐小时累加：浓度与流量必须取同一时刻的那一对；某时刻没有流量读数时，该小时排放量按 0 计。
// inWindow(at) 决定哪些小时进窗口——月、季度、年累计只是窗口不同，换算与配对完全相同。
function emissionTons(data, outletId, metric, inWindow) {
  const settings = data.settings;
  const flowByAt = {};
  for (const r of readingsOf(data, { outletId, metric: '流量' })) {
    if (isCounted(r, deviceOf(data, r.deviceId), settings)) flowByAt[r.at] = Number(r.value);
  }
  let tons = 0;
  for (const r of readingsOf(data, { outletId, metric })) {
    if (!inWindow(r.at)) continue;
    if (!isCounted(r, deviceOf(data, r.deviceId), settings)) continue;
    tons += hourlyEmissionTons(effectiveConcentration(r, settings), flowByAt[r.at] || 0, settings);
  }
  return tons;
}

// 月总量（吨）：当月逐小时累加
function monthTotal(data, outletId, metric, month) {
  return store.round(emissionTons(data, outletId, metric, (at) => store.monthOf(at) === month), 4);
}

// 季度总量（吨）：当季逐小时累加，与月总量同一套换算，不做任何按天外推
function quarterTotal(data, outletId, metric, quarter) {
  return store.round(emissionTons(data, outletId, metric, (at) => store.quarterOf(store.monthOf(at)) === quarter), 4);
}

// 季度许可量：年许可量 × 该季度实际天数 ÷ 全年天数
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  const year = String(quarter).slice(0, 4);
  return store.round((annual * store.daysInQuarter(quarter)) / store.daysInYear(year), 4);
}

// 许可年窗口 [start, end)：参考月一日所在的那个许可年，从许可年起始日的周年起算一年
function permitYearWindow(permitYearStart, refMonth) {
  const [, sm, sd] = String(permitYearStart).split('-').map(Number);
  const [ry, rm] = String(refMonth).split('-').map(Number);
  let y = ry;
  if (rm < sm || (rm === sm && sd > 1)) y = ry - 1;
  const p = (n) => String(n).padStart(2, '0');
  return { start: y + '-' + p(sm) + '-' + p(sd), end: y + 1 + '-' + p(sm) + '-' + p(sd) };
}

function latestMonth(data) {
  const months = data.readings.map((r) => store.monthOf(r.at)).sort();
  return months.length ? months[months.length - 1] : store.nowText().slice(0, 7);
}

// 年累计（吨）：按许可年累计（单位台账里的许可年起始日），跨自然年不重置，
// 也不带入其他许可年的数据。opts.outletId 给定时只算这个排放口，否则全部排放口合计
// （每个排放口各自按其单位的许可年取窗）；opts.asOf 是参考月，缺省取数据里最新的月份。
function accumulatedTons(data, metric, opts) {
  const o = opts || {};
  const outletIds = o.outletId ? [o.outletId] : data.outlets.map((x) => x.id);
  const refMonth = o.asOf || latestMonth(data);
  let total = 0;
  for (const outletId of outletIds) {
    const outlet = outletOf(data, outletId);
    const plant = outlet ? plantOf(data, outlet.plantId) : null;
    const permitStart = (plant && plant.permitYearStart) || data.settings.permitYearStart;
    const win = permitYearWindow(permitStart, refMonth);
    total += emissionTons(data, outletId, metric, (at) => at >= win.start && at < win.end);
  }
  return store.round(total, 4);
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD', { outletId, asOf: month }),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮', { outletId, asOf: month }),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage,
  hourlyEmissionTons, emissionTons, monthTotal, quarterTotal, quarterPermitTons,
  permitYearWindow, accumulatedTons,
  exceedance, outletsOf, outletSummary,
};
