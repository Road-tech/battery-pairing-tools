/* ============================================================
 * calc.js — 电池计算与一致性分析
 * ============================================================ */

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

  /* ---------- 一致性 & 质量报告 ----------
   * cells: [{id, capacity, resistance, convertedCapacity?}]
   * config: {cellType, ratedCapacity, ratedMaxDischarge, chargeCurrent, testStartV, testCutoffV, testDischargeI, fullChargeV}
   */
  consistencyReport(cells, config) {
    if (!cells || cells.length === 0) return null;
    const chem = BATTERY_CHEMISTRIES[config.cellType] || BATTERY_CHEMISTRIES.custom;

    const caps = cells.map(c => c.capacity).filter(v => v != null && !isNaN(v));
    const ress = cells.map(c => c.resistance).filter(v => v != null && !isNaN(v));

    const capStats = this.stats(caps);
    const resStats = this.stats(ress);

    // 估算满容量：优先用表格的换算容量列(用户已换算)，否则用电压曲线反推
    const convCaps = cells.map(c => c.convertedCapacity).filter(v => v != null && !isNaN(v) && v > 0);
    const hasConv = convCaps.length > caps.length * 0.5; // 超过半数有换算容量才采用
    const avgMeasured = capStats.avg;
    const estFullAvg = hasConv ? this.stats(convCaps).avg
      : this.estimateFullCapacity(avgMeasured, config.testStartV, config.testCutoffV, config.cellType);
    const estFullMax = hasConv ? this.stats(convCaps).max
      : this.estimateFullCapacity(capStats.max, config.testStartV, config.testCutoffV, config.cellType);

    // 容量达标率：用估算满容量(或换算容量)逐颗对比额定容量
    const ratedCap = config.ratedCapacity || 0;
    const estPerCell = cells.map(c => {
      if (hasConv && c.convertedCapacity != null && c.convertedCapacity > 0) return c.convertedCapacity;
      if (c.capacity == null) return null;
      return this.estimateFullCapacity(c.capacity, config.testStartV, config.testCutoffV, config.cellType);
    }).filter(v => v != null);
    const meetRated = ratedCap > 0 ? estPerCell.filter(c => c >= ratedCap).length : 0;
    const meetPct = estPerCell.length > 0 ? (meetRated / estPerCell.length) * 100 : 0;

    // 容量/内阻分布分级（批次级，比单串级宽松，配对的目的正是处理批次偏差）
    const capGrade = this._grade(capStats.devPct, [2, 4, 7]);   // % 极差/均值
    const resGrade = this._grade(resStats.devPct, [10, 20, 35]);

    // 综合质量等级
    const qualityScore = (capGrade.score + resGrade.score) / 2;
    let qualityLevel, qualityClass;
    if (qualityScore >= 2.5) { qualityLevel = "优秀"; qualityClass = "quality-excellent"; }
    else if (qualityScore >= 2) { qualityLevel = "良好"; qualityClass = "quality-good"; }
    else if (qualityScore >= 1) { qualityLevel = "一般"; qualityClass = "quality-fair"; }
    else { qualityLevel = "较差"; qualityClass = "quality-poor"; }

    return {
      capStats, resStats,
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
