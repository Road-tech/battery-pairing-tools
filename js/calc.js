/* ============================================================
 * calc.js — 电池计算与一致性分析
 * ============================================================ */

// 标准容量测试倍率(C)：按 IEC 61960，电芯额定容量以 0.2C（C5，5 小时率）恒流放电测得，
// 故 Peukert 折算的基准倍率设为 0.2C——以该倍率测得即等于标称容量，无需修正。
const STD_RATE_C = 0.2;
// 锂电 Peukert 常数(典型值 ~1.05)：用于把实测放电倍率折算到标准倍率
const PEUKERT_K = 1.05;

const Calc = {

  /* ---------- 基础统计 ---------- */
  stats(arr) {
    if (!arr || arr.length === 0) return null;
    const n = arr.length;
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const max = Math.max(...arr);
    const min = Math.min(...arr);
    const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const range = max - min;
    const cv = avg !== 0 ? (std / avg) * 100 : 0;     // 变异系数 %
    const devPct = avg !== 0 ? (range / avg) * 100 : 0; // 极差/均值 %
    return { n, sum, avg, max, min, std, variance, range, cv, devPct };
  },

  /* ---------- 百分位数 ----------
   * sorted: 升序数组；p: 0~1
   */
  percentile(sorted, p) {
    const n = sorted.length;
    if (n === 0) return 0;
    if (n === 1) return sorted[0];
    const idx = (n - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  },

  /* ---------- 分布形态评估 ----------
   * 用「中间 90% (P5~P95) 的跨度」衡量典型电芯偏差，少数极端离群电芯不会拉低评级；
   * concentratedPct = 落在 [median*(1-tol), median*(1+tol)] 中部区间的电芯占比，
   *   直观反映"绝大多数电芯是否集中在中间"。
   * tol: 集中率区间半宽（容量 0.02=±2%，内阻 0.10=±10%）
   * 返回 {median, p5, p95, centralDevPct, concentratedPct}
   */
  centralSpread(values, tol = 0.02) {
    if (!values || values.length === 0) return { median: 0, p5: 0, p95: 0, centralDevPct: 0, concentratedPct: 0 };
    const s = [...values].sort((a, b) => a - b);
    const median = this.percentile(s, 0.5);
    const p5 = this.percentile(s, 0.05);
    const p95 = this.percentile(s, 0.95);
    const centralDevPct = median ? (p95 - p5) / median * 100 : 0;
    const lo = median * (1 - tol), hi = median * (1 + tol);
    let inBand = 0;
    for (const v of s) if (v >= lo && v <= hi) inBand++;
    const concentratedPct = s.length ? inBand / s.length * 100 : 0;
    return { median, p5, p95, centralDevPct, concentratedPct };
  },

  /* ---------- 放电曲线：估算截止电压下可用容量比例 ----------
   * curve: [[voltage, ratio], ...] ratio 从0(满充)到1(放空)
   * 返回给定截止电压时已放出的容量比例 (0~1)
   * 即：从满充放到 cutoffV，能放出多少比例的容量
   */
  capacityRatioAt(cutoffV, curve) {
    if (!curve || curve.length === 0) return 1;
    // 曲线按电压降序排列
    const sorted = [...curve].sort((a, b) => b[0] - a[0]);
    const topV = sorted[0][0];
    const bottomV = sorted[sorted.length - 1][0];

    // 截止电压高于满充 -> 容量0
    if (cutoffV >= topV) return 0;
    // 截止电压低于最低点 -> 满容量
    if (cutoffV <= bottomV) return 1;

    // 线性插值
    for (let i = 0; i < sorted.length - 1; i++) {
      const [v1, r1] = sorted[i];
      const [v2, r2] = sorted[i + 1];
      if (cutoffV <= v1 && cutoffV >= v2) {
        const t = (v1 - cutoffV) / (v1 - v2);
        return r1 + t * (r2 - r1);
      }
    }
    return 1;
  },

  /* ---------- 估算电芯真实满容量 ----------
   * 测试从 testStartV 放到 testCutoffV 得到 measured 容量
   * 推算放到 chemistry 最低电压时的满容量
   */
  estimateFullCapacity(measured, testStartV, testCutoffV, chemistry) {
    const curve = DISCHARGE_CURVE[chemistry] || DISCHARGE_CURVE.custom;
    const ratioMeasured = this.capacityRatioAt(testCutoffV, curve) - this.capacityRatioAt(testStartV, curve);
    if (ratioMeasured <= 0.001) return measured;
    return measured / ratioMeasured;
  },

  /* ---------- 估算给定截止电压下的可用容量 ---------- */
  capacityAtVoltage(fullCapacity, cutoffV, chemistry) {
    const curve = DISCHARGE_CURVE[chemistry] || DISCHARGE_CURVE.custom;
    const ratio = this.capacityRatioAt(cutoffV, curve);
    return fullCapacity * ratio;
  },

  /* ---------- 容量换算：根据实测条件换算为标准满容量 ----------
   * 不再依赖用户手填的换算容量，改由系统依据测试三参数自动换算：
   *   ① 电压区间换算：把 [testStartV → testCutoffV] 区间测得容量，
   *      按放电曲线反推到 [满充上限 → 最低截止] 的满容量；
   *   ② 放电倍率修正：用 Peukert 方程把实测倍率(testDischargeC)折算到标准倍率(STD_RATE_C=0.2C，即 IEC 61960 的 C5 标准容量测试倍率)。
   *      大电流测得容量偏小(极化)→ 往大修正；小电流测得偏大 → 往小修正。
   * measured      实测容量(mAh)，在 [testStartV, testCutoffV]、testDischargeC 倍率下测得
   * 返回          标准条件下满容量(mAh)
   */
  convertCapacity(measured, testStartV, testCutoffV, testDischargeC, chemistry) {
    if (measured == null || isNaN(measured) || measured <= 0) return measured;
    // ① 电压区间换算
    const qVol = this.estimateFullCapacity(measured, testStartV, testCutoffV, chemistry);
    // ② 放电倍率修正（倍率由用户以 C 直接给出，无需再由电流/容量反推）
    const rate = (testDischargeC == null || isNaN(testDischargeC) || testDischargeC <= 0) ? STD_RATE_C : testDischargeC;
    const factor = Math.pow(rate / STD_RATE_C, PEUKERT_K - 1);
    return qVol * factor;
  },

  /* ---------- 给每颗电芯计算系统换算容量 ----------
   * 替代「用户手填换算容量」，写回 cell.convertedCapacity，供一致性报告、
   * 配对分配、容量预估统一使用。
   * 注意：convertCapacity 已对测量值做了电压区间 + 放电倍率的标准化，
   * 故直接作为满容量基准，无需再做 hasConv 分支判断。
   */
  applyConverted(cells, config) {
    const safe = (v, d) => (v == null || isNaN(v)) ? d : v;
    const ts = safe(config.testStartV, 4.2);
    const tc = safe(config.testCutoffV, 3.0);
    const ti = safe(config.testDischargeC, 1);
    return cells.map(c => {
      if (c.capacity == null) return c;
      const conv = this.convertCapacity(c.capacity, ts, tc, ti, config.cellType);
      return Object.assign({}, c, { convertedCapacity: Math.round(conv) });
    });
  },

  /* ---------- 一致性 & 质量报告 ----------
   * cells: [{id, capacity, resistance, convertedCapacity?}]
   * config: {cellType, ratedCapacity, ratedMaxDischarge, chargeCurrent, testStartV, testCutoffV, testDischargeC, fullChargeV}
   */
  consistencyReport(cells, config) {
    if (!cells || cells.length === 0) return null;
    const chem = BATTERY_CHEMISTRIES[config.cellType] || BATTERY_CHEMISTRIES.custom;

    const caps = cells.map(c => c.capacity).filter(v => v != null && !isNaN(v));
    const ress = cells.map(c => c.resistance).filter(v => v != null && !isNaN(v));

    const capStats = this.stats(caps);
    const resStats = this.stats(ress);

    // 分布形态：中间 90% 跨度 + 集中率（少数离群不拉低评级）
    const capCentral = this.centralSpread(caps, 0.02);
    const resCentral = this.centralSpread(ress, 0.10);
    const convCaps = cells.map(c => c.convertedCapacity).filter(v => v != null && !isNaN(v) && v > 0);

    // 容量换算满容量：系统已按测试三参数(起始电压/截止电压/放电倍率)换算
    const convStats = this.stats(convCaps);
    const estFullAvg = convStats.avg;
    const estFullMax = convStats.max;

    // 容量达标率：用换算满容量逐颗对比额定容量
    const ratedCap = config.ratedCapacity || 0;
    const meetRated = ratedCap > 0 ? convCaps.filter(c => c >= ratedCap).length : 0;
    const meetPct = convCaps.length > 0 ? (meetRated / convCaps.length) * 100 : 0;

    // 容量/内阻分布分级：以「中间 90% 跨度」为评级主驱动（少数离群不拉低整体一致性）
    const capGrade = this._grade(capCentral.centralDevPct, [2, 4, 7]);   // 中90%跨度/中位 %
    const resGrade = this._grade(resCentral.centralDevPct, [10, 20, 35]);

    // 综合质量等级
    const qualityScore = (capGrade.score + resGrade.score) / 2;
    let qualityLevel, qualityClass;
    if (qualityScore >= 2.5) { qualityLevel = "优秀"; qualityClass = "quality-excellent"; }
    else if (qualityScore >= 2) { qualityLevel = "良好"; qualityClass = "quality-good"; }
    else if (qualityScore >= 1) { qualityLevel = "一般"; qualityClass = "quality-fair"; }
    else { qualityLevel = "较差"; qualityClass = "quality-poor"; }

    return {
      capStats, resStats,
      capCentral, resCentral,
      estFullAvg, estFullMax,
      meetRated, meetPct,
      ratedCap,
      capGrade, resGrade,
      qualityLevel, qualityClass,
      chemistry: chem
    };
  },

  // 分级：返回 {level, score(0~3), class}
  _grade(devPct, thresholds) {
    // thresholds = [excellentMax, goodMax, fairMax]
    if (devPct <= thresholds[0]) return { level: "优秀", score: 3, class: "ok" };
    if (devPct <= thresholds[1]) return { level: "良好", score: 2, class: "ok" };
    if (devPct <= thresholds[2]) return { level: "一般", score: 1, class: "warn" };
    return { level: "较差", score: 0, class: "danger" };
  },

  /* ---------- 成品电池配置：方式一 电压+容量 → 串并联 ---------- */
  configByVoltageCapacity(targetV, targetCapAh, cellType, cellCapacity) {
    const chem = BATTERY_CHEMISTRIES[cellType] || BATTERY_CHEMISTRIES.custom;
    const cellCapAh = (cellCapacity || chem.nominalV) ? (cellCapacity / 1000) : 0; // mAh→Ah
    // 用每颗实际容量（mAh转Ah）
    const s = Math.round(targetV / chem.nominalV);
    const p = s > 0 && cellCapAh > 0 ? Math.ceil(targetCapAh / cellCapAh) : 0;
    const totalCells = s * p;
    const actualV = s * chem.nominalV;
    const actualCapAh = p * cellCapAh;
    const energyWh = actualV * actualCapAh;
    return { s, p, totalCells, actualV, actualCapAh, energyWh, nominalV: chem.nominalV, cellCapacitymAh: cellCapacity };
  },

  /* ---------- 成品电池配置：方式二 串+并 → 电压容量 ---------- */
  configBySeriesParallel(s, p, cellType, cellCapacity) {
    const chem = BATTERY_CHEMISTRIES[cellType] || BATTERY_CHEMISTRIES.custom;
    const cellCapAh = cellCapacity / 1000;
    const totalCells = s * p;
    const actualV = s * chem.nominalV;
    const actualCapAh = p * cellCapAh;
    const energyWh = actualV * actualCapAh;
    return { s, p, totalCells, actualV, actualCapAh, energyWh, nominalV: chem.nominalV, cellCapacitymAh: cellCapacity };
  },

  /* ---------- 计算偏差百分比 ---------- */
  devPct(max, min, avg) {
    if (!avg || avg === 0) return 0;
    return ((max - min) / avg) * 100;
  },

  // 相对均值的偏差
  spreadPct(values) {
    const s = this.stats(values);
    if (!s || s.avg === 0) return 0;
    return s.devPct;
  },

  /* ---------- 估算不同保护电压下的成品可用容量 ---------- */
  packCapacityAtVoltage(perStringFullCapacityAh, seriesCount, cutoffV, chemistry) {
    // 单串（并联组）的满容量 = 并联电芯容量之和
    // 截止电压下，单串可用比例 × 单串满容量 = 单串可用容量
    // 整组容量 = 单串容量（串联不增加容量）
    const ratio = this.capacityRatioAt(cutoffV, DISCHARGE_CURVE[chemistry] || DISCHARGE_CURVE.custom);
    return perStringFullCapacityAh * ratio;
  },

  /* ---------- 数字格式化 ---------- */
  fmt(v, decimals = 1) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(decimals);
  },

  fmtInt(v) {
    if (v == null || isNaN(v)) return "—";
    return Math.round(v).toLocaleString();
  }
};
