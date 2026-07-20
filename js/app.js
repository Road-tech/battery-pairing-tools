/* ============================================================
 * app.js — 主应用控制器
 * ============================================================ */

// 配对偏差场景预设（与 knowledge.js 的 CONSISTENCY_REFERENCE 一致）
const TOLERANCE_SCENARIOS = {
  power:   { capIn: 1,  resIn: 5,  capBetween: 0.5, resBetween: 5,
             name: "动力电池（电动车 / 无人机）",
             note: "大电流放电，一致性要求最高，否则木桶效应严重影响续航与寿命" },
  storage: { capIn: 2,  resIn: 10, capBetween: 1,   resBetween: 10,
             name: "储能电池（家庭 / 电站储能）",
             note: "中小电流充放，一致性要求中等，关注长期循环寿命" },
  etool:   { capIn: 2,  resIn: 10, capBetween: 1,   resBetween: 10,
             name: "电动工具 / 电动自行车",
             note: "脉冲大电流，内阻一致性尤其重要，影响放电平台" },
  backup:  { capIn: 3,  resIn: 15, capBetween: 2,   resBetween: 15,
             name: "备用电源 / 低功耗设备",
             note: "小电流长期待机，一致性要求相对宽松" },
  custom:  { capIn: null, resIn: null, capBetween: null, resBetween: null,
             name: "自定义",
             note: "用户手动调整偏差参数，不套用任何预设" }
};

// 各化学体系默认倍率（C）与推荐最大/充电倍率
const DEFAULT_C_RATES = {
  ncm:    { dischargeC: 5,   chargeC: 1,   maxDischargeC: 8,  maxChargeC: 1.5 },
  lfp:    { dischargeC: 3,   chargeC: 0.5,  maxDischargeC: 5,  maxChargeC: 1 },
  lco:    { dischargeC: 2,   chargeC: 0.5,  maxDischargeC: 3,  maxChargeC: 1 },
  lmto:   { dischargeC: 10,  chargeC: 2,   maxDischargeC: 15, maxChargeC: 3 },
  custom: { dischargeC: 3,   chargeC: 0.5,  maxDischargeC: 5,  maxChargeC: 1 }
};

const App = {
  state: {
    cells: null,         // 解析后的电芯数组
    config: null,        // 电芯参数
    packInfo: null,      // 成品电池配置结果 {s, p, total, ...}
    pairing: null,       // 配对结果
    tolerance: null,
    excludedIds: new Set()  // 已自动剔除的电芯序号集合
  },

  // 返回参与分析/配对的有效电芯（排除已剔除的）
  activeCells() {
    if (!this.state.cells) return null;
    const ex = this.state.excludedIds;
    if (!ex || ex.size === 0) return this.state.cells;
    return this.state.cells.filter(c => !ex.has(c.id));
  },

  // 剔除数量
  excludedCount() {
    return this.state.excludedIds ? this.state.excludedIds.size : 0;
  },

  init() {
    this.bindUpload();
    this.bindCellParams();
    this.bindPackConfig();
    this.bindTolerance();
    this.bindPairing();
    this.bindStepNav();
    document.getElementById("knowledgeArea").innerHTML = renderKnowledge();
    this.updateStepStates();
  },

  /* ==================== 上传 ==================== */
  bindUpload() {
    const dz = document.getElementById("dropzone");
    const fi = document.getElementById("fileInput");

    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", e => {
      e.preventDefault();
      dz.classList.remove("dragover");
      if (e.dataTransfer.files.length) this.handleFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener("change", e => {
      if (e.target.files.length) this.handleFile(e.target.files[0]);
    });

    document.getElementById("btnReupload").addEventListener("click", () => {
      document.getElementById("fileInput").value = "";
      this.resetUpload();
    });
    document.getElementById("btnDownloadParsed").addEventListener("click", () => {
      if (this.state.cells) ExcelIO.exportParsed(this.state.cells);
    });
  },

  async handleFile(file) {
    const status = document.getElementById("uploadStatus");
    status.className = "upload-status";
    status.classList.remove("hidden");
    status.innerHTML = "⏳ 正在解析文件...";

    try {
      const buf = await file.arrayBuffer();
      const result = ExcelIO.parse(buf);

      if (!result.ok) {
        status.className = "upload-status err";
        status.innerHTML = "❌ " + result.error;
        this.toast("解析失败", "error");
        this.resetUpload();
        return;
      }

      this.state.cells = result.cells;
      this.state.colMap = result.colMap;
      this.state.sheetName = result.sheetName;
      this.state.parseWarnings = result.warnings || [];
      this.state.excludedIds = new Set();  // 重新上传时清空剔除状态
      status.className = "upload-status ok";
      status.innerHTML = `✅ 成功解析 <strong>${result.cells.length}</strong> 颗电芯数据（工作表：${result.sheetName}），请填写下方参数后点击「解析并分析电芯」查看明细与换算容量`;

      this.toast(`成功解析 ${result.cells.length} 颗电芯`, "success");
      this.updateStepStates();
    } catch (e) {
      status.className = "upload-status err";
      status.innerHTML = "❌ 文件读取失败：" + e.message;
      this.toast("文件读取失败", "error");
    }
  },

  renderPreview(opts) {
    const wrap = document.getElementById("dataPreviewWrap");
    const grid = document.getElementById("previewGrid");
    const count = document.getElementById("dataCount");
    const note = document.getElementById("previewNote");
    const cells = opts.cells || [];
    const colMap = opts.colMap || {};

    wrap.classList.remove("hidden");
    count.textContent = `${cells.length} 颗`;

    const show = cells.slice(0, 200);
    grid.innerHTML = show.map(c => `
      <div class="cell-item">
        <span class="ci-idx">${c.id}</span>
        <span class="ci-cap">${c.capacity != null ? c.capacity : '<span class="text-mute">缺失</span>'}</span>
        <span class="ci-res">${c.resistance != null ? c.resistance : '<span class="text-mute">缺失</span>'}</span>
        <span class="ci-conv">${c.convertedCapacity != null ? Calc.fmtInt(c.convertedCapacity) : '<span class="text-mute">—</span>'}</span>
      </div>
    `).join("");
    if (cells.length > 200) {
      note.innerHTML = `仅显示前 200 颗，共 ${cells.length} 颗。`;
    } else {
      const warns = opts.warnings || [];
      note.innerHTML = warns.length
        ? "⚠️ " + warns.join("；")
        : `已识别列：序号=${colMap.colId?.name || "自动"} / 容量=${colMap.colCap?.name || ""} / 内阻=${colMap.colRes?.name || ""}；换算容量为系统按测试参数自动换算的满容量。`;
    }
  },

  resetUpload() {
    document.getElementById("dataPreviewWrap").classList.add("hidden");
    document.getElementById("consistencyReport").classList.add("hidden");
    document.getElementById("uploadStatus").classList.add("hidden");
    this.state.cells = null;
    this.state.colMap = null;
    this.state.sheetName = null;
    this.state.parseWarnings = null;
    this.state.config = null;
    this.state.excludedIds = new Set();
    this.updateStepStates();
  },

  /* ==================== 电芯参数 ==================== */
  bindCellParams() {
    // 类型变化时更新满充电压、测试起始/截止电压，以及倍率默认值
    document.getElementById("cellType").addEventListener("change", e => {
      const chem = BATTERY_CHEMISTRIES[e.target.value];
      if (chem) {
        document.getElementById("fullChargeV").value = chem.chargeV;
        document.getElementById("testStartV").value = chem.chargeV;
        const cv = document.getElementById("testCutoffV");
        if (!cv.value || parseFloat(cv.value) === 0) cv.value = (e.target.value === "lfp" ? 2.5 : 3.0);
      }
      const rates = DEFAULT_C_RATES[e.target.value] || DEFAULT_C_RATES.ncm;
      document.getElementById("ratedMaxDischargeC").value = rates.dischargeC;
      document.getElementById("chargeCurrentC").value = rates.chargeC;
      this.updateCurrentHints();
    });

    // 额定容量 / 各倍率变化时，自动换算并更新 C→A 提示
    ["ratedCapacity", "ratedMaxDischargeC", "chargeCurrentC", "testDischargeC"].forEach(id => {
      document.getElementById(id).addEventListener("input", () => this.updateCurrentHints());
    });

    document.getElementById("btnAnalyze").addEventListener("click", () => this.analyzeCells());
    this.updateCurrentHints();
  },

  // 根据额定容量(mAh)与倍率(C)换算电流(A)
  cToA(cRate, capacityMah) {
    if (!cRate || !capacityMah || capacityMah <= 0) return 0;
    return (cRate * capacityMah) / 1000;
  },

  updateCurrentHints() {
    const cap = parseFloat(document.getElementById("ratedCapacity").value) || 0;
    const dC = parseFloat(document.getElementById("ratedMaxDischargeC").value) || 0;
    const cC = parseFloat(document.getElementById("chargeCurrentC").value) || 0;
    const tC = parseFloat(document.getElementById("testDischargeC").value) || 0;
    document.getElementById("hintMaxDischargeA").textContent =
      cap ? `≈ ${this.cToA(dC, cap).toFixed(1)}A` : "≈ -";
    document.getElementById("hintChargeA").textContent =
      cap ? `≈ ${this.cToA(cC, cap).toFixed(1)}A` : "≈ -";
    document.getElementById("hintTestDischargeA").textContent =
      cap ? `≈ ${this.cToA(tC, cap).toFixed(1)}A` : "≈ -";
  },

  readConfig() {
    const ratedCapacity = parseFloat(document.getElementById("ratedCapacity").value) || 0;
    const dischargeC = parseFloat(document.getElementById("ratedMaxDischargeC").value) || 0;
    const chargeC = parseFloat(document.getElementById("chargeCurrentC").value) || 0;
    return {
      cellType: document.getElementById("cellType").value,
      ratedCapacity,
      ratedMaxDischarge: this.cToA(dischargeC, ratedCapacity),   // 自动换算为 A
      chargeCurrent: this.cToA(chargeC, ratedCapacity),          // 自动换算为 A
      testStartV: parseFloat(document.getElementById("testStartV").value) || 0,
      testCutoffV: parseFloat(document.getElementById("testCutoffV").value) || 0,
      testDischargeC: parseFloat(document.getElementById("testDischargeC").value) || 0,
      fullChargeV: parseFloat(document.getElementById("fullChargeV").value) || 0
    };
  },

  analyzeCells() {
    if (!this.state.cells || this.state.cells.length === 0) {
      this.toast("请先上传电芯数据", "warn");
      this.scrollTo("sec-input");
      return;
    }
    const config = this.readConfig();
    if (config.ratedCapacity <= 0) {
      this.toast("请填写额定容量", "warn");
      return;
    }
    this.state.config = config;

    // 根据测试三参数（起始电压/截止电压/放电倍率）刷新系统换算容量
    this.state.cells = Calc.applyConverted(this.state.cells, config);

    // 展示「已解析电芯数据」——含每颗电芯的系统换算容量
    this.renderPreview({
      cells: this.state.cells,
      warnings: this.state.parseWarnings || [],
      colMap: this.state.colMap || {},
      sheetName: this.state.sheetName || "—"
    });

    const active = this.activeCells();
    if (!active || active.length === 0) {
      this.toast("所有电芯已被剔除，请恢复部分电芯后再分析", "warn");
      return;
    }
    const report = Calc.consistencyReport(active, config);
    this.renderConsistency(report, config);
    this.bindExcludeButtons();
    this.toast(this.excludedCount() > 0
      ? `已剔除 ${this.excludedCount()} 颗，基于剩余 ${active.length} 颗完成分析`
      : "一致性分析完成", "success");
    this.updateStepStates();
  },

  // 绑定「自动剔除 / 全部恢复」按钮（在一致性报告渲染后动态绑定）
  bindExcludeButtons() {
    const btnExclude = document.getElementById("btnAutoExclude");
    if (btnExclude) {
      btnExclude.addEventListener("click", () => this.autoExclude());
    }
    const btnRestore = document.getElementById("btnRestoreExclude");
    if (btnRestore) {
      btnRestore.addEventListener("click", () => this.restoreExcluded());
    }
  },

  // 自动剔除：把当前 rejected 列表中的电芯序号加入 excludedIds，然后重新分析
  autoExclude() {
    const active = this.activeCells();
    if (!active || active.length === 0) return;

    // 复用 _rejectedCellsList 的筛选逻辑，拿到当前建议剔除的电芯
    const data = this._computeRejected(active);
    if (!data || !data.rejected || data.rejected.length === 0) {
      this.toast("当前没有建议剔除的电芯", "info");
      return;
    }
    data.rejected.forEach(c => this.state.excludedIds.add(c.id));
    this.toast(`已自动剔除 ${data.rejected.length} 颗电芯`, "success");
    // 重新分析（基于剩余电芯），可多轮剔除逐步收敛
    this.analyzeCells();
  },

  // 全部恢复：清空 excludedIds，重新分析
  restoreExcluded() {
    if (this.excludedCount() === 0) {
      this.toast("当前没有已剔除的电芯", "info");
      return;
    }
    const n = this.excludedCount();
    this.state.excludedIds.clear();
    this.toast(`已恢复全部 ${n} 颗电芯`, "success");
    this.analyzeCells();
  },

  renderConsistency(r, cfg) {
    const el = document.getElementById("consistencyReport");
    el.classList.remove("hidden");

    const cs = r.capStats, rs = r.resStats;
    const chem = r.chemistry;
    const exN = this.excludedCount();
    const exBanner = exN > 0
      ? `<div class="excluded-banner">⚠️ 已自动剔除 <strong>${exN}</strong> 颗电芯，以下统计与配对均基于剩余 <strong>${cs.n}</strong> 颗。点击下方「全部恢复」可还原。</div>`
      : '';

    el.innerHTML = `
      ${exBanner}
      <div class="report-section">
        <h4>📊 电芯整体统计（共 ${cs.n} 颗${exN > 0 ? `，已剔除 ${exN} 颗` : ''}）</h4>
        <div class="stat-grid">
          <div class="stat-card"><div class="lbl">容量均值</div><div class="val">${Calc.fmt(cs.avg)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">容量最大值</div><div class="val">${Calc.fmtInt(cs.max)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">容量最小值</div><div class="val">${Calc.fmtInt(cs.min)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">容量极差</div><div class="val">${Calc.fmtInt(cs.range)}<span class="unit">mAh</span></div></div>
          <div class="stat-card ${r.capGrade.class === 'danger' ? 'danger' : ''}"><div class="lbl">中心偏差率(中90%)</div><div class="val">${Calc.fmt(r.capCentral.centralDevPct, 2)}<span class="unit">%</span></div></div>
          <div class="stat-card ${r.capCentral.concentratedPct >= 90 ? 'ok' : ''}"><div class="lbl">集中率(±2%)</div><div class="val">${Calc.fmt(r.capCentral.concentratedPct, 1)}<span class="unit">%</span></div></div>
        </div>
        <div class="stat-grid" style="margin-top:10px">
          <div class="stat-card"><div class="lbl">内阻均值</div><div class="val">${Calc.fmt(rs.avg, 2)}<span class="unit">mΩ</span></div></div>
          <div class="stat-card"><div class="lbl">内阻最大值</div><div class="val">${Calc.fmt(rs.max, 2)}<span class="unit">mΩ</span></div></div>
          <div class="stat-card"><div class="lbl">内阻最小值</div><div class="val">${Calc.fmt(rs.min, 2)}<span class="unit">mΩ</span></div></div>
          <div class="stat-card"><div class="lbl">内阻极差</div><div class="val">${Calc.fmt(rs.range, 2)}<span class="unit">mΩ</span></div></div>
          <div class="stat-card ${r.resGrade.class === 'danger' ? 'danger' : ''}"><div class="lbl">中心偏差率(中90%)</div><div class="val">${Calc.fmt(r.resCentral.centralDevPct, 2)}<span class="unit">%</span></div></div>
          <div class="stat-card ${r.resCentral.concentratedPct >= 90 ? 'ok' : ''}"><div class="lbl">集中率(±10%)</div><div class="val">${Calc.fmt(r.resCentral.concentratedPct, 1)}<span class="unit">%</span></div></div>
        </div>
      </div>

      <div class="report-section">
        <h4>🔋 容量换算</h4>
        <div class="stat-grid">
          <div class="stat-card highlight"><div class="lbl">换算电芯满容量(均值)</div><div class="val">${Calc.fmtInt(r.estFullAvg)}<span class="unit">mAh</span></div></div>
          <div class="stat-card highlight"><div class="lbl">换算电芯满容量(最大)</div><div class="val">${Calc.fmtInt(r.estFullMax)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">额定容量</div><div class="val">${Calc.fmtInt(r.ratedCap)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">达标率(≥额定)</div><div class="val">${Calc.fmt(r.meetPct, 1)}<span class="unit">% (${r.meetRated}/${cs.n})</span></div></div>
        </div>
        <p style="font-size:12px;color:var(--text-mute);margin-top:8px">
          说明：系统根据测试参数自动换算——实测容量在 ${cfg.testStartV}V→${cfg.testCutoffV}V、放电倍率 ${cfg.testDischargeC}C（≈${cfg.ratedCapacity ? (cfg.testDischargeC * cfg.ratedCapacity / 1000).toFixed(1) : 0}A）测得，结合 ${chem.name} 放电曲线反推满放(至 ${chem.dischargeMinV}V) 容量。注：4.2V→3.0V 仅放出约 90% 满容量，换算会补回 3.0V→${chem.dischargeMinV}V 的尾段（约 8%~10%）；再按 Peukert 方程将放电倍率折算到标准 0.2C(C5) 条件。达标率按换算满容量逐颗对比额定容量计算。
        </p>
      </div>

      <div class="report-section">
        <h4>📋 质量评估</h4>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px">
          <span class="quality-badge ${r.qualityClass}">综合等级：${r.qualityLevel}</span>
          <span style="font-size:13px;color:var(--text-soft)">容量一致性：${r.capGrade.level} · 内阻一致性：${r.resGrade.level}</span>
        </div>
        ${this._qualityAdvice(r)}
      </div>

      <div class="report-section">
        <h4>📈 容量分布</h4>
        ${this._distributionChart(this.activeCells().map(c => c.capacity).filter(v => v != null))}
      </div>

      <div class="report-section">
        <h4>📈 内阻分布</h4>
        ${this._distributionChart(this.activeCells().map(c => c.resistance).filter(v => v != null), 1)}
      </div>

      <div class="report-section">
        <h4>⚠️ 建议剔除的电芯</h4>
        ${this._rejectedCellsList(this.activeCells())}
      </div>
    `;
  },

  _qualityAdvice(r) {
    const capConc = r.capCentral.concentratedPct;
    const resConc = r.resCentral.concentratedPct;
    const fewOutliers = (capConc >= 88 && resConc >= 88);
    let advice = [];
    if (r.capGrade.level === "较差") advice.push("容量偏差过大，建议重新筛选或分档使用，避免木桶效应严重影响续航。");
    else if (r.capGrade.level === "一般") advice.push("容量偏差偏大，组电池时务必做好串间均衡，建议保留更多余量。");
    else advice.push(`容量一致性${r.capGrade.level}，约 ${capConc.toFixed(0)}% 电芯容量集中在 ±2% 中部区间${fewOutliers ? "，仅个别电芯偏离，整体一致性良好" : ""}。`);

    if (r.resGrade.level === "较差") advice.push("内阻偏差过大，并联组内可能出现电流不均、局部过热，建议按内阻分档。");
    else if (r.resGrade.level === "一般") advice.push("内阻偏差一般，注意大电流放电时的发热管理。");
    else advice.push(`内阻一致性${r.resGrade.level}，约 ${resConc.toFixed(0)}% 电芯内阻集中在 ±10% 中部区间${fewOutliers ? "，仅个别电芯偏离，整体一致性良好" : ""}。`);

    if (fewOutliers) advice.push("评级基于中间 90% 电芯的分布形态，少数偏离较大的电芯不影响整体一致性结论（已列于「建议剔除的电芯」）。");

    if (r.meetPct < 50) advice.push(`仅 ${r.meetPct.toFixed(1)}% 电芯达到额定容量，可能存在测试条件偏差或电芯衰减。`);

    return `<ul style="margin-left:18px;font-size:13px;color:var(--text-soft);line-height:1.8">${advice.map(a => `<li>${a}</li>`).join("")}</ul>`;
  },

  _distributionChart(values, decimals = 0) {
    if (!values.length) return "<p>无数据</p>";
    const s = Calc.stats(values);
    const bins = 8;
    const step = s.range > 0 ? s.range / bins : 1;
    const hist = new Array(bins).fill(0);
    const labels = [];
    const fmt = v => decimals > 0 ? Number(v).toFixed(decimals) : Math.round(v).toString();
    for (let i = 0; i < bins; i++) {
      const lo = s.min + i * step;
      labels.push(`${fmt(lo)}~${fmt(lo + step)}`);
    }
    values.forEach(v => {
      let idx = Math.floor((v - s.min) / step);
      if (idx >= bins) idx = bins - 1;
      if (idx < 0) idx = 0;
      hist[idx]++;
    });
    const maxH = Math.max(...hist);
    return `
      <div style="margin-top:8px">
        ${hist.map((h, i) => {
          const pct = maxH ? (h / maxH * 100) : 0;
          return `<div class="bar-chart-row">
            <span class="lbl">${labels[i]}</span>
            <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="val">${h} 颗</span>
          </div>`;
        }).join("")}
      </div>
    `;
  },

  // 计算 2σ 偏离的电芯列表（剔除依据）
  _computeRejected(cells) {
    if (!cells || cells.length === 0) return [];
    const valid = cells.filter(c => c.capacity != null && c.resistance != null && !isNaN(c.capacity) && !isNaN(c.resistance));
    if (valid.length === 0) return [];

    const cs = Calc.stats(valid.map(c => c.capacity));
    const rs = Calc.stats(valid.map(c => c.resistance));
    const capThreshold = cs.std * 2;   // 容量 ±2σ
    const resThreshold = rs.std * 2;   // 内阻 +2σ（只偏大才算异常）

    const rejected = valid.filter(c => {
      const capDev = Math.abs(c.capacity - cs.avg);
      const resDev = c.resistance - rs.avg;
      return capDev > capThreshold || resDev > resThreshold;
    }).sort((a, b) => b.resistance - a.resistance); // 按内阻降序，突出问题电芯

    return { rejected, cs, rs, capThreshold, resThreshold };
  },

  _rejectedCellsList(cells) {
    const data = this._computeRejected(cells);
    if (!data || data.rejected.length === 0) {
      return `
        <p style="font-size:13px;color:var(--text-mute)">经 2σ 统计筛选，所有电芯的容量/内阻均在合理波动范围内，暂无明确建议剔除项。</p>
        ${this._excludedSummary()}
      `;
    }

    const { rejected, cs, rs, capThreshold, resThreshold } = data;

    return `
      <p style="font-size:12px;color:var(--text-mute);margin-bottom:8px">按容量/内阻 2σ 原则筛选，以下 ${rejected.length} 颗电芯偏离整体平均水平较多，建议剔除或单独分档使用：</p>
      <div class="rejected-actions">
        <button class="btn btn-primary btn-sm" id="btnAutoExclude">⚡ 自动剔除这 ${rejected.length} 颗</button>
        ${this._excludedSummary()}
      </div>
      <div class="table-wrap">
        <table class="dev-table">
          <thead><tr><th>序号</th><th>容量(mAh)</th><th>容量偏差</th><th>内阻(mΩ)</th><th>内阻偏差</th><th>剔除原因</th></tr></thead>
          <tbody>
            ${rejected.map(c => {
              const capDevPct = cs.avg ? ((c.capacity - cs.avg) / cs.avg * 100) : 0;
              const resDevPct = rs.avg ? ((c.resistance - rs.avg) / rs.avg * 100) : 0;
              const reasons = [];
              if (Math.abs(c.capacity - cs.avg) > capThreshold) reasons.push(`容量${c.capacity > cs.avg ? '偏高' : '偏低'} ${Math.abs(capDevPct).toFixed(2)}%`);
              if (c.resistance - rs.avg > resThreshold) reasons.push(`内阻偏高 ${Math.abs(resDevPct).toFixed(2)}%`);
              return `<tr>
                <td><strong>${c.id}</strong></td>
                <td>${c.capacity}</td>
                <td>${capDevPct > 0 ? '+' : ''}${capDevPct.toFixed(2)}%</td>
                <td>${c.resistance}</td>
                <td>${resDevPct > 0 ? '+' : ''}${resDevPct.toFixed(2)}%</td>
                <td>${reasons.join('，')}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  },

  // 已剔除电芯的小结条（含「全部恢复」按钮）
  _excludedSummary() {
    const n = this.excludedCount();
    if (n === 0) return '';
    return `
      <span class="excluded-summary">
        <span class="excluded-badge">已剔除 ${n} 颗</span>
        <span class="excluded-hint">（这些电芯将不参与后续配对计算）</span>
      </span>
      <button class="btn btn-ghost btn-sm" id="btnRestoreExclude">↩ 全部恢复</button>
    `;
  },

  /* ==================== 成品电池配置 ==================== */
  bindPackConfig() {
    document.querySelectorAll(".mode-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".mode-panel").forEach(p => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("mode-" + tab.dataset.mode).classList.add("active");
        this.computePackConfig();
      });
    });

    ["targetVoltage", "targetCapacityAh", "seriesCount", "parallelCount"].forEach(id => {
      document.getElementById(id).addEventListener("input", () => this.computePackConfig());
    });

    // 电芯类型变化影响成品配置
    document.getElementById("cellType").addEventListener("change", () => this.computePackConfig());
  },

  computePackConfig() {
    const cfg = this.readConfig();
    const chem = BATTERY_CHEMISTRIES[cfg.cellType] || BATTERY_CHEMISTRIES.custom;

    // 刷新系统换算容量（基于当前测试参数），保证参数变更后使用最新值
    if (this.state.cells) this.state.cells = Calc.applyConverted(this.state.cells, cfg);

    // 每颗电芯容量：使用系统换算容量（已按测试三参数标准化），否则回落实测容量
    let cellCapacity = cfg.ratedCapacity;
    let capSource = "额定容量";
    const active = this.activeCells();
    if (active && active.length) {
      const convCaps = active.map(c => c.convertedCapacity).filter(v => v != null && v > 0);
      if (convCaps.length) {
        cellCapacity = Math.round(convCaps.reduce((a, b) => a + b, 0) / convCaps.length);
        capSource = "容量换算(均值)";
      } else {
        const caps = active.map(c => c.capacity).filter(v => v != null && v > 0);
        if (caps.length) {
          cellCapacity = Math.round(caps.reduce((a, b) => a + b, 0) / caps.length);
          capSource = "实测容量(均值)";
        }
      }
    }

    const activeMode = document.querySelector(".mode-tab.active").dataset.mode;
    let result;

    if (activeMode === "vc") {
      const tv = parseFloat(document.getElementById("targetVoltage").value);
      const tc = parseFloat(document.getElementById("targetCapacityAh").value);
      if (!tv || !tc || tc <= 0) {
        document.getElementById("vcHint").className = "hint-box empty";
        document.getElementById("packConfigResult").classList.add("hidden");
        return;
      }
      result = Calc.configByVoltageCapacity(tv, tc, cfg.cellType, cellCapacity);
      document.getElementById("vcHint").className = "hint-box";
      document.getElementById("vcHint").innerHTML =
        `按 ${chem.nominalV}V 标称电压计算 → <strong>${result.s} 串 ${result.p} 并</strong>，共需 <strong>${result.totalCells}</strong> 颗电芯。`;
    } else {
      const s = parseInt(document.getElementById("seriesCount").value);
      const p = parseInt(document.getElementById("parallelCount").value);
      if (!s || !p || s <= 0 || p <= 0) {
        document.getElementById("spHint").className = "hint-box empty";
        document.getElementById("packConfigResult").classList.add("hidden");
        return;
      }
      result = Calc.configBySeriesParallel(s, p, cfg.cellType, cellCapacity);
      document.getElementById("spHint").className = "hint-box";
      document.getElementById("spHint").innerHTML =
        `${s} 串 ${p} 并 → 电压 <strong>${result.actualV}V</strong>，容量 <strong>${Calc.fmt(result.actualCapAh, 2)}Ah</strong>，共需 <strong>${result.totalCells}</strong> 颗电芯。`;
    }

    this.state.packInfo = result;
    this.renderPackConfig(result, chem, cellCapacity, capSource);
    this.updateStepStates();
  },

  renderPackConfig(r, chem, cellCapacity, capSource) {
    const el = document.getElementById("packConfigResult");
    el.classList.remove("hidden");
    const uploaded = this.state.cells ? this.state.cells.length : 0;
    const excluded = this.excludedCount();
    const remaining = uploaded - excluded;
    const enough = remaining >= r.totalCells;
    el.innerHTML = `
      <div class="rb-title">成品电池参数预览</div>
      <div class="rb-grid">
        <div class="rb-item"><div class="lbl">配置</div><div class="val">${r.s}S${r.p}P</div></div>
        <div class="rb-item"><div class="lbl">标称电压</div><div class="val">${r.actualV}<span class="unit">V</span></div></div>
        <div class="rb-item"><div class="lbl">容量</div><div class="val">${Calc.fmt(r.actualCapAh)}<span class="unit">Ah</span></div></div>
        <div class="rb-item"><div class="lbl">总能量</div><div class="val">${Calc.fmt(r.energyWh)}<span class="unit">Wh</span></div></div>
        <div class="rb-item"><div class="lbl">需要电芯</div><div class="val">${r.totalCells}<span class="unit">颗</span></div></div>
        <div class="rb-item"><div class="lbl">单电芯容量</div><div class="val">${cellCapacity}<span class="unit">mAh (${capSource})</span></div></div>
        <div class="rb-item"><div class="lbl">已上传</div><div class="val">${uploaded}<span class="unit">颗</span></div></div>
        <div class="rb-item"><div class="lbl">已剔除</div><div class="val" style="color:${excluded ? 'var(--warn)' : 'inherit'}">${excluded}<span class="unit">颗</span></div></div>
        <div class="rb-item"><div class="lbl">剔除后剩余</div><div class="val" style="color:${enough ? 'var(--ok)' : 'var(--danger)'}">${remaining}<span class="unit">颗</span></div></div>
        <div class="rb-item"><div class="lbl">是否充足</div><div class="val" style="color:${enough ? 'var(--ok)' : 'var(--danger)'}">${enough ? '✓ 充足' : `✗ 差 ${r.totalCells - remaining} 颗`}</div></div>
      </div>
    `;
  },

  /* ==================== 偏差设置 ==================== */
  bindTolerance() {
    const sceneSel = document.getElementById("tolScene");
    const inputs = ["tolCapIn", "tolResIn", "tolCapBetween", "tolResBetween"];

    // 初始：套用默认场景（storage）的数值
    this.applyScene("storage");

    // 场景切换 → 填充对应数值
    sceneSel.addEventListener("change", () => {
      const key = sceneSel.value;
      if (key !== "custom" && TOLERANCE_SCENARIOS[key]) {
        this.applyScene(key);
      }
      this.updateSceneNote();
      this.readTolerance();
    });

    // 手动修改任一数值 → 场景自动变「自定义」
    inputs.forEach(id => {
      document.getElementById(id).addEventListener("input", () => {
        if (sceneSel.value !== "custom") {
          sceneSel.value = "custom";
          this.updateSceneNote();
        }
        this.readTolerance();
      });
    });

    this.updateSceneNote();
    this.readTolerance();
  },

  // 套用某个场景的4个偏差数值到输入框
  applyScene(key) {
    const s = TOLERANCE_SCENARIOS[key];
    if (!s) return;
    document.getElementById("tolCapIn").value = s.capIn;
    document.getElementById("tolResIn").value = s.resIn;
    document.getElementById("tolCapBetween").value = s.capBetween;
    document.getElementById("tolResBetween").value = s.resBetween;
  },

  // 更新场景说明小条
  updateSceneNote() {
    const sel = document.getElementById("tolScene");
    const key = sel ? sel.value : "storage";
    const s = TOLERANCE_SCENARIOS[key];
    const noteEl = document.getElementById("tolSceneNote");
    if (!s || !noteEl) return;
    noteEl.innerHTML =
      `<span class="scene-badge scene-${key}">${s.name}</span>` +
      `<span class="scene-text">${s.note}</span>`;
  },

  readTolerance() {
    this.state.tolerance = {
      tolCapIn: parseFloat(document.getElementById("tolCapIn").value) || 0,
      tolResIn: parseFloat(document.getElementById("tolResIn").value) || 0,
      tolCapBetween: parseFloat(document.getElementById("tolCapBetween").value) || 0,
      tolResBetween: parseFloat(document.getElementById("tolResBetween").value) || 0
    };
    return this.state.tolerance;
  },

  /* ==================== 配对计算 ==================== */
  bindPairing() {
    document.getElementById("btnPair").addEventListener("click", () => this.runPairing());
    document.getElementById("btnDownloadPair").addEventListener("click", () => {
      if (this.state.pairing && this.state.pairing.ok && this.state.packInfo) {
        ExcelIO.exportPairing(this.state.pairing, this.state.packInfo);
        this.toast("配对表已下载", "success");
      }
    });
    // 配对模式切换时，显示/隐藏“达标优先”的串间次级目标
    document.querySelectorAll('input[name="pairMode"]').forEach(r => {
      r.addEventListener("change", () => {
        const strict = this.getPairMode() === "strict";
        document.getElementById("strictObj").style.display = strict ? "flex" : "none";
        const tip = document.getElementById("strictObjTip");
        if (tip) tip.style.display = strict ? "block" : "none";
      });
    });
  },

  bindStepNav() {
    const map = {
      1: "sec-input",
      2: "sec-analysis",
      3: "sec-packconfig",
      4: "sec-tolerance",
      5: "sec-pairing",
      6: "sec-report"
    };
    document.querySelectorAll(".topbar-steps .step").forEach(step => {
      step.addEventListener("click", () => {
        const id = map[step.dataset.step];
        if (id) this.scrollTo(id);
      });
    });
  },

  runPairing() {
    // 前置检查
    const errBox = document.getElementById("pairError");
    const resultEl = document.getElementById("pairResult");
    const reportEl = document.getElementById("packReport");
    errBox.classList.add("hidden");
    resultEl.classList.add("hidden");
    reportEl.classList.add("hidden");
    // 清除上次可能残留的缺口报告
    resultEl.querySelectorAll(".gap-report").forEach(el => el.remove());

    if (!this.state.cells || this.state.cells.length === 0) {
      this.showError("无法计算", ["请先上传电芯数据（第 1 步：上传数据 & 参数）。"]);
      this.scrollTo("sec-input");
      return;
    }
    if (!this.state.packInfo) {
      this.showError("无法计算", ["请先完成成品电池配置（第 3 步）。"]);
      this.scrollTo("sec-packconfig");
      return;
    }

    const { s, p, totalCells } = this.state.packInfo;
    const tol = this.readTolerance();
    const cfg = this.readConfig();
    // 用最新配置刷新系统换算容量，保证参数变更后配对使用最新值
    if (this.state.cells) this.state.cells = Calc.applyConverted(this.state.cells, cfg);
    this.state.config = cfg;

    const active = this.activeCells();
    const mode = this.getPairMode();
    // 达标优先下的次级目标：串间均衡优先（默认）在保持每串达标前提下降低串间偏差
    const strictObjEl = document.querySelector('input[name="strictObj"]:checked');
    const balanceBetween = mode === "strict" && (!strictObjEl || strictObjEl.value === "between");
    const result = mode === "strict"
      ? Pair.runStrict(active, s, p, tol, { balanceBetween })
      : Pair.run(active, s, p, tol);
    this.state.pairing = result;

    if (!result.ok) {
      this.handlePairError(result);
      return;
    }

    this.renderPairTable(result, tol);
    // 达标优先模式且有缺口时，渲染缺口报告
    if (mode === "strict" && result.gap > 0) {
      this.renderGapReport(result, tol);
    }
    this.renderPackReport(result, this.state.packInfo, this.state.config, tol);
    const exMsg = this.excludedCount() > 0 ? `（已剔除 ${this.excludedCount()} 颗）` : '';
    if (mode === "strict" && result.gap > 0) {
      this.toast(`达标优先：已配 ${result.matched}/${s} 串，缺口 ${result.gapCells} 颗${exMsg}`, "warn");
    } else {
      this.toast(`配对完成：${s}S${p}P 共 ${result.total} 颗${exMsg}`, "success");
    }
    this.updateStepStates();
    this.scrollTo("sec-pairing");
  },

  getPairMode() {
    const checked = document.querySelector('input[name="pairMode"]:checked');
    return checked ? checked.value : "balanced";
  },

  renderGapReport(result, tol) {
    const el = document.getElementById("pairResult");
    const r = result.requirement;
    const gapStrs = result.gap;
    const gapCells = result.gapCells;
    const html = `
      <div class="gap-report">
        <div class="gap-title">⚠️ 达标优先配对：电芯不足，无法配满 ${result.targetS} 串</div>
        <div class="gap-summary">
          <div class="gap-stat"><span class="num">${result.matched}</span>/ ${result.targetS} 串已配齐</div>
          <div class="gap-stat"><span class="num">${gapStrs}</span>串尚未配出</div>
          <div class="gap-stat"><span class="num">${gapCells}</span>颗电芯缺口</div>
        </div>
        <div class="gap-req">
          <div>已配 ${result.matched} 串的电芯均值：容量 <strong>${r.capAvg}</strong> mAh，内阻 <strong>${r.resAvg}</strong> mΩ。</div>
          <div>剩余电芯中，找不到能同时满足「串内容量偏差 ≤ <span class="req-tag">${r.tolCapIn}%</span>」和「串内内阻偏差 ≤ <span class="req-tag">${r.tolResIn}%</span>」的 ${result.targetP} 颗组合。</div>
          <div>建议补充的电芯要求：容量在 <span class="req-tag">${r.capLo} ~ ${r.capHi} mAh</span>，内阻在 <span class="req-tag">${r.resLo} ~ ${r.resHi} mΩ</span>，约 <strong>${gapCells}</strong> 颗。</div>
          <div style="margin-top:6px;color:#8a6d00;">提示：也可放宽偏差范围、调小串并联数，或切换为「均衡优先」模式强制配满。</div>
        </div>
      </div>
    `;
    el.insertAdjacentHTML("afterbegin", html);
  },

  handlePairError(result) {
    let title, msgs = [];
    const exN = this.excludedCount();
    if (result.error === "cells_not_enough") {
      title = "电芯数量不足";
      msgs.push(`目标配置需要 ${result.need} 颗电芯，当前仅有 ${result.have} 颗${exN > 0 ? `（已自动剔除 ${exN} 颗，原始 ${result.have + exN} 颗）` : ''}。`);
      msgs.push(`还差 <strong>${result.short}</strong> 颗电芯才能完成配对。`);
      if (exN > 0) {
        msgs.push("建议：在「电芯参数设置」区点击「全部恢复」还原已剔除电芯，或补充更多电芯测试数据，或调小目标电压/容量、串并联数。");
      } else {
        msgs.push("建议：补充更多电芯测试数据，或调小目标电压/容量、串并联数。");
      }
    } else if (result.error === "cells_invalid") {
      title = "电芯数据无效或缺失";
      msgs.push(`共 ${result.total} 行，其中 ${result.invalid} 行缺少容量或内阻数据，有效数据仅 ${result.valid} 行${exN > 0 ? `（已剔除 ${exN} 颗）` : ''}。`);
      msgs.push(`目标需要 ${result.need} 颗，有效电芯${result.valid >= result.need ? "数量足够" : `还差 ${result.need - result.valid} 颗`}。`);
      msgs.push("建议：补全缺失的容量/内阻测量值后重新上传。");
    } else {
      title = "配对失败";
      msgs.push(result.error);
    }
    this.showError(title, msgs);
  },

  showError(title, msgs) {
    const errBox = document.getElementById("pairError");
    errBox.classList.remove("hidden");
    errBox.innerHTML = `<div class="err-title">❌ ${title}</div><ul>${msgs.map(m => `<li>${m}</li>`).join("")}</ul>`;
  },

  renderPairTable(result, tol) {
    const el = document.getElementById("pairResult");
    el.classList.remove("hidden");
    const tabsEl = document.getElementById("strTabs");
    const thead = document.querySelector("#pairTable thead");
    const tbody = document.querySelector("#pairTable tbody");

    thead.innerHTML = `<tr>
      <th>位置</th><th>电芯序号</th><th>容量(mAh)</th><th>内阻(mΩ)</th><th>相对均值偏差(容量/内阻)</th>
    </tr>`;

    // 构建标签：每串一个 + 末尾“未使用”标签（20+ 串时横向滚动切换）
    const tabs = [];
    result.strings.forEach(str => {
      const status = (str.capOk && str.resOk) ? "ok" : (str.capOk || str.resOk ? "warn" : "danger");
      tabs.push({ type: "str", idx: str.idx, count: str.count, status });
    });
    if (result.unused && result.unused.length > 0) {
      tabs.push({ type: "unused", count: result.unused.length });
    }

    tabsEl.innerHTML = tabs.map((t, i) => {
      if (t.type === "unused") {
        return `<button class="str-tab unused ${i === 0 ? "active" : ""}" data-tab="${i}">未使用 (${t.count})</button>`;
      }
      const dotCls = t.status === "ok" ? "ok" : t.status === "warn" ? "warn" : "danger";
      const mark = t.status === "ok" ? "" : " ⚠";
      return `<button class="str-tab ${i === 0 ? "active" : ""}" data-tab="${i}" title="第${t.idx}串 · ${t.count}颗">
        <span class="dot ${dotCls}"></span>第${t.idx}串${mark}</button>`;
    }).join("");

    // 渲染指定标签（仅当前串的清单，保持 block 内不拉长页面）
    const renderTab = (i) => {
      tabsEl.querySelectorAll(".str-tab").forEach(b => b.classList.toggle("active", +b.dataset.tab === i));
      const activeBtn = tabsEl.querySelector(`.str-tab[data-tab="${i}"]`);
      if (activeBtn) activeBtn.scrollIntoView({ inline: "nearest", block: "nearest" });
      const tab = tabs[i];
      let html = "";
      if (tab.type === "unused") {
        const title = result.mode === "strict"
          ? `未使用电芯（${result.unused.length} 颗，无法凑出满足偏差要求的达标串）`
          : `未使用电芯（多余 ${result.unused.length} 颗，因上传数量超过目标配置）`;
        html += `<tr class="str-header" style="background:var(--warn-soft)"><td colspan="5">${title}</td></tr>`;
        result.unused.forEach(cell => {
          html += `<tr class="cell-row">
            <td>—</td>
            <td><strong>${cell.id}</strong></td>
            <td>${cell.capacity}</td>
            <td>${cell.resistance}</td>
            <td><span class="text-mute">未使用</span></td>
          </tr>`;
        });
      } else {
        const str = result.strings[tab.idx - 1];
        html += `<tr class="str-header">
          <td colspan="5">
            第 ${str.idx} 串 · ${str.count}颗 ·
            容量均值 ${str.capAvg.toFixed(1)}mAh (偏差 ${str.capDev.toFixed(2)}% ${str.capOk ? "✓" : "⚠"}) ·
            内阻均值 ${str.resAvg.toFixed(2)}mΩ (偏差 ${str.resDev.toFixed(2)}% ${str.resOk ? "✓" : "⚠"})
          </td>
        </tr>`;
        str.cells.forEach((cell, ci) => {
          const capDevPct = str.capAvg ? ((cell.capacity - str.capAvg) / str.capAvg * 100) : 0;
          const resDevPct = str.resAvg ? ((cell.resistance - str.resAvg) / str.resAvg * 100) : 0;
          const capCls = Math.abs(capDevPct) > tol.tolCapIn ? "warn-cell" : "";
          const resCls = Math.abs(resDevPct) > tol.tolResIn ? "warn-cell" : "";
          html += `<tr class="cell-row">
            <td>P${ci + 1}</td>
            <td><strong>${cell.id}</strong></td>
            <td class="${capCls}">${cell.capacity}</td>
            <td class="${resCls}">${cell.resistance}</td>
            <td><span style="color:${Math.abs(capDevPct) > tol.tolCapIn ? 'var(--warn)' : 'var(--text-mute)'}">${capDevPct > 0 ? '+' : ''}${capDevPct.toFixed(2)}%</span> / <span style="color:${Math.abs(resDevPct) > tol.tolResIn ? 'var(--warn)' : 'var(--text-mute)'}">${resDevPct > 0 ? '+' : ''}${resDevPct.toFixed(2)}%</span></td>
          </tr>`;
        });
      }
      tbody.innerHTML = html;
    };

    tabsEl.querySelectorAll(".str-tab").forEach(b => {
      b.addEventListener("click", () => renderTab(+b.dataset.tab));
    });
    renderTab(0);
  },

  /* ==================== 成品电池报告 ==================== */
  renderPackReport(result, pack, cfg, tol) {
    const el = document.getElementById("packReport");
    el.classList.remove("hidden");
    const chem = BATTERY_CHEMISTRIES[cfg.cellType] || BATTERY_CHEMISTRIES.custom;
    // 系统已统一换算：result.between.capAvg 即为换算后的满容量均值，无需再分支
    // 达标优先模式可能配不满，实际配齐串数
    const actualS = result.mode === "strict" && result.gap > 0 ? result.matched : pack.s;
    const gapBanner = (result.mode === "strict" && result.gap > 0)
      ? `<div style="margin-bottom:12px;padding:10px 14px;background:var(--warn-soft);border-radius:8px;border-left:3px solid var(--warn);font-size:13px;color:var(--text-soft)">
          ⚠️ 达标优先模式：目标 ${pack.s} 串，实际配齐 <strong>${result.matched}</strong> 串，缺 <strong>${result.gap}</strong> 串（${result.gapCells} 颗）。以下报告基于已配 ${result.matched} 串统计。
        </div>`
      : "";

    // 单串容量 = P 颗有效容量之和（有效容量优先为换算容量，否则为实测容量）
    const perStrCapAh = result.between.capAvg * pack.p / 1000;
    const packCapacityAh = perStrCapAh; // 串联不增加容量

    // 预估峰值容量（用容量最大的串）与最弱串（木桶）
    const maxStrCap = Math.max(...result.strings.map(s => s.capSum));
    const peakCapAh = maxStrCap / 1000;
    const minStrCap = Math.min(...result.strings.map(s => s.capSum));
    const weakestCapAh = minStrCap / 1000;

    // 不同保护电压下的预估容量
    const protectVoltages = [3.0, 2.8, 2.5];
    const capAtVoltages = protectVoltages.map(v => {
      const ratio = Calc.capacityRatioAt(v, DISCHARGE_CURVE[cfg.cellType] || DISCHARGE_CURVE.custom);
      // 系统换算容量已是满放基准，直接按比例折算
      const fullStrCapAh = result.between.capAvg * pack.p / 1000;
      return { v, capAh: fullStrCapAh * ratio, ratio };
    });

    const capSourceText = `系统根据测试参数自动换算——实测容量 ${cfg.testStartV}V→${cfg.testCutoffV}V、放电倍率 ${cfg.testDischargeC}C（≈${cfg.ratedCapacity ? (cfg.testDischargeC * cfg.ratedCapacity / 1000).toFixed(1) : 0}A），结合 ${chem.name} 放电曲线反推满放(至 ${chem.dischargeMinV}V)：4.2V→3.0V 仅约 90% 满容量，换算补回 3.0V→${chem.dischargeMinV}V 尾段(约 8%~10%)，再按 Peukert 方程折算到标准 0.2C(C5)，不再额外估算。`;

    el.innerHTML = `
      ${gapBanner}
      <div class="report-section">
        <h4>🔋 大电池基本信息</h4>
        <div class="stat-grid">
          <div class="stat-card highlight"><div class="lbl">配置</div><div class="val">${actualS}S${pack.p}P${result.gap > 0 ? `<span class="unit" style="color:var(--warn)">/ 目标${pack.s}S</span>` : ''}</div></div>
          <div class="stat-card highlight"><div class="lbl">标称电压</div><div class="val">${pack.actualV}<span class="unit">V</span></div></div>
          <div class="stat-card highlight"><div class="lbl">预估容量</div><div class="val">${Calc.fmt(packCapacityAh)}<span class="unit">Ah</span></div></div>
          <div class="stat-card"><div class="lbl">总能量</div><div class="val">${Calc.fmt(pack.actualV * packCapacityAh)}<span class="unit">Wh</span></div></div>
          <div class="stat-card"><div class="lbl">电芯总数</div><div class="val">${pack.totalCells}<span class="unit">颗</span></div></div>
          <div class="stat-card"><div class="lbl">单电芯预估容量（均值）</div><div class="val">${Calc.fmtInt(result.between.capAvg)}<span class="unit">mAh</span></div></div>
        </div>
        <p style="font-size:12px;color:var(--text-mute);margin-top:8px">
          📌 容量预估方式：${capSourceText}
        </p>
      </div>

      <div class="report-section">
        <h4>⚡ 容量预估</h4>
        <div class="stat-grid">
          <div class="stat-card highlight"><div class="lbl">预估峰值容量(最强串)</div><div class="val">${Calc.fmt(peakCapAh)}<span class="unit">Ah</span></div></div>
          <div class="stat-card ${weakestCapAh < packCapacityAh * 0.98 ? 'danger' : ''}"><div class="lbl">最弱串容量(木桶)</div><div class="val">${Calc.fmt(weakestCapAh)}<span class="unit">Ah</span></div></div>
          <div class="stat-card"><div class="lbl">实测可用容量</div><div class="val">${Calc.fmt(packCapacityAh)}<span class="unit">Ah</span></div></div>
          <div class="stat-card"><div class="lbl">容量利用率</div><div class="val">${Calc.fmt(weakestCapAh / peakCapAh * 100, 1)}<span class="unit">%</span></div></div>
        </div>
      </div>

      <div class="report-section">
        <h4>🛡️ 保护板不同截止电压下预估容量</h4>
        <p style="font-size:12px;color:var(--text-mute);margin-bottom:8px">基于 ${chem.name} 放电曲线估算（满充 ${cfg.fullChargeV || chem.chargeV}V 放至对应截止电压）。系统已按测试参数将每颗电芯换算至满放基准。</p>
        <table class="dev-table">
          <thead><tr><th>保护截止电压</th><th>可用容量比例</th><th>预估成品容量</th><th>预估可放出能量</th></tr></thead>
          <tbody>
            ${capAtVoltages.map(c => `
              <tr>
                <td><strong>${c.v}V</strong></td>
                <td>${(c.ratio * 100).toFixed(1)}%</td>
                <td>${Calc.fmt(c.capAh)} Ah</td>
                <td>${Calc.fmt(c.capAh * pack.actualV)} Wh</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div class="report-section">
        <h4>📏 各串容量与内阻偏差</h4>
        <div class="table-wrap">
        <table class="dev-table">
          <thead><tr>
            <th>串号</th><th>容量均值(mAh)</th><th>串内容量偏差</th><th>内阻均值(mΩ)</th><th>串内内阻偏差</th><th>评估</th>
          </tr></thead>
          <tbody>
            ${result.strings.map(str => {
              const capCls = str.capDev <= tol.tolCapIn ? "ok" : (str.capDev <= tol.tolCapIn * 1.5 ? "warn" : "danger");
              const resCls = str.resDev <= tol.tolResIn ? "ok" : (str.resDev <= tol.tolResIn * 1.5 ? "warn" : "danger");
              const evalText = (str.capOk && str.resOk) ? "✓ 达标" : "⚠ 偏差超标";
              return `<tr>
                <td><strong>第${str.idx}串</strong></td>
                <td>${str.capAvg.toFixed(1)}</td>
                <td class="${capCls}">${str.capDev.toFixed(2)}%</td>
                <td>${str.resAvg.toFixed(2)}</td>
                <td class="${resCls}">${str.resDev.toFixed(2)}%</td>
                <td>${evalText}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
        </div>
      </div>

      <div class="report-section">
        <h4>🔗 串间偏差分析</h4>
        <div class="stat-grid">
          <div class="stat-card ${result.between.capOk ? '' : 'danger'}"><div class="lbl">串间容量偏差</div><div class="val">${result.between.capDev.toFixed(2)}<span class="unit">%</span></div></div>
          <div class="stat-card ${result.between.resOk ? '' : 'danger'}"><div class="lbl">串间内阻偏差</div><div class="val">${result.between.resDev.toFixed(2)}<span class="unit">%</span></div></div>
          <div class="stat-card"><div class="lbl">串间容量极差</div><div class="val">${Calc.fmtInt(result.between.capMax - result.between.capMin)}<span class="unit">mAh</span></div></div>
          <div class="stat-card"><div class="lbl">串间内阻极差</div><div class="val">${Calc.fmt(result.between.resSumMax - result.between.resSumMin, 2)}<span class="unit">mΩ</span></div></div>
        </div>
        <div style="margin-top:12px;padding:12px 16px;background:${result.between.capOk && result.between.resOk ? 'var(--ok-soft)' : 'var(--warn-soft)'};border-radius:8px;border-left:3px solid ${result.between.capOk && result.between.resOk ? 'var(--ok)' : 'var(--warn)'};font-size:13px">
          ${result.mode === 'strict' && result.balanceBetween
            ? '🔧 已启用「串间均衡优先」：在<b>每串均达标</b>的硬约束下，通过约束内交换把各串均值拉平，<b>未牺牲任何串内一致性</b>。若电芯本身分布较散，串间偏差存在理论下限（达标要求各串占据不同容量带），此时可放宽容差或补充更集中批次的电芯。'
            : ''}
          ${result.between.capOk && result.between.resOk
            ? '✅ 串间一致性达标，配对方案可用。'
            : '⚠️ 串间偏差超出设定范围，建议：① 调整偏差容忍度 ② 增加并联数摊薄差异 ③ 更换部分极端电芯。'}
        </div>
      </div>

      <div class="report-section">
        <h4>💡 使用建议</h4>
        <ul style="margin-left:18px;font-size:13px;color:var(--text-soft);line-height:1.9">
          <li>建议满充后静置12小时观察各串压差，压差>0.05V需检查配对或BMS均衡能力。</li>
          <li>额定最大放电电流 ${cfg.ratedMaxDischarge}A，本组成品最大放电电流约 ${Calc.fmt(cfg.ratedMaxDischarge * pack.p)}A（并联叠加），注意保护板与线材载流。</li>
          <li>建议充电电流 ≤ ${Calc.fmt(cfg.chargeCurrent * pack.p)}A（${cfg.chargeCurrent}A×${pack.p}并），首充用0.5C以下。</li>
          <li>木桶效应：实际可用容量以最弱串为准（${Calc.fmt(weakestCapAh)}Ah），峰值为 ${Calc.fmt(peakCapAh)}Ah。</li>
        </ul>
      </div>
    `;
  },

  /* ==================== 工具方法 ==================== */
  toast(msg, type = "success") {
    const t = document.getElementById("toast");
    t.className = "toast " + type + " show";
    t.textContent = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  },

  scrollTo(id) {
    const el = document.getElementById(id);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  },

  updateStepStates() {
    const steps = {
      1: this.state.cells && this.state.cells.length > 0,
      2: !!document.querySelector("#consistencyReport:not(.hidden)"),
      3: !!this.state.packInfo,
      4: true,
      5: this.state.pairing && this.state.pairing.ok,
      6: !!document.querySelector("#packReport:not(.hidden)")
    };
    document.querySelectorAll(".topbar-steps .step").forEach(el => {
      const n = parseInt(el.dataset.step);
      el.style.opacity = steps[n] ? "1" : "0.5";
      el.style.background = steps[n] ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)";
    });
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());

// 暴露到 window，方便测试与外部调用
if (typeof window !== "undefined") window.App = App;
