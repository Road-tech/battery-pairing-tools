/* ============================================================
 * knowledge.js — 电池基础知识数据
 * ============================================================ */

// 各类锂电池的电压参数
const BATTERY_CHEMISTRIES = {
  ncm: {
    name: "三元锂 (NCM/NCA)",
    nominalV: 3.7,        // 标称电压
    chargeV: 4.2,         // 满充上限电压
    dischargeMinV: 2.5,   // 最低放电截止电压
    storageV: 3.85,       // 存储电压
    cycleLife: "800-2000",
    energyDensity: "200-280 Wh/kg",
    color: "#3b82f6"
  },
  lfp: {
    name: "磷酸铁锂 (LFP)",
    nominalV: 3.2,
    chargeV: 3.65,
    dischargeMinV: 2.5,
    storageV: 3.4,
    cycleLife: "2000-6000",
    energyDensity: "140-180 Wh/kg",
    color: "#16a34a"
  },
  lco: {
    name: "钴酸锂 (LCO)",
    nominalV: 3.7,
    chargeV: 4.2,
    dischargeMinV: 3.0,
    storageV: 3.85,
    cycleLife: "500-1000",
    energyDensity: "180-220 Wh/kg",
    color: "#a855f7"
  },
  lmto: {
    name: "钛酸锂 (LTO)",
    nominalV: 2.4,
    chargeV: 2.7,
    dischargeMinV: 1.5,
    storageV: 2.4,
    cycleLife: "10000-30000",
    energyDensity: "70-100 Wh/kg",
    color: "#f59e0b"
  },
  custom: {
    name: "自定义",
    nominalV: 3.7,
    chargeV: 4.2,
    dischargeMinV: 2.5,
    storageV: 3.8,
    cycleLife: "—",
    energyDensity: "—",
    color: "#64748b"
  }
};

// 不同使用场景下电芯一致性参考偏差（合理范围）
const CONSISTENCY_REFERENCE = [
  {
    scene: "动力电池 (电动车/无人机)",
    capIntraPct: "≤1%",
    resIntraPct: "≤5%",
    capInterPct: "≤0.5%",
    resInterPct: "≤5%",
    note: "大电流放电，一致性要求最高，否则木桶效应严重影响续航与寿命"
  },
  {
    scene: "储能电池 (家庭/电站储能)",
    capIntraPct: "≤2%",
    resIntraPct: "≤10%",
    capInterPct: "≤1%",
    resInterPct: "≤10%",
    note: "中小电流充放，一致性要求中等，关注长期循环寿命"
  },
  {
    scene: "电动工具 / 电动自行车",
    capIntraPct: "≤2%",
    resIntraPct: "≤10%",
    capInterPct: "≤1%",
    resInterPct: "≤10%",
    note: "脉冲大电流，内阻一致性尤其重要，影响放电平台"
  },
  {
    scene: "备用电源 / 低功耗设备",
    capIntraPct: "≤3%",
    resIntraPct: "≤15%",
    capInterPct: "≤2%",
    resInterPct: "≤15%",
    note: "小电流长期待机，一致性要求相对宽松"
  }
];

// 放电曲线参考点（满充→0%容量对应的电压）
// 用于估算不同截止电压下可用容量比例
const DISCHARGE_CURVE = {
  ncm: [
    // [电压, 累计已放出容量比例 0~1]
    [4.20, 0.00], [4.05, 0.05], [3.90, 0.15], [3.80, 0.25],
    [3.70, 0.40], [3.60, 0.55], [3.50, 0.70], [3.40, 0.82],
    [3.30, 0.90], [3.20, 0.95], [3.10, 0.975], [3.00, 0.99],
    [2.80, 0.997], [2.50, 1.00]
  ],
  lfp: [
    [3.65, 0.00], [3.40, 0.03], [3.30, 0.10], [3.25, 0.30],
    [3.20, 0.50], [3.18, 0.70], [3.15, 0.85], [3.10, 0.93],
    [3.00, 0.97], [2.80, 0.995], [2.50, 1.00]
  ],
  lco: [
    [4.20, 0.00], [4.00, 0.10], [3.85, 0.25], [3.75, 0.45],
    [3.65, 0.65], [3.55, 0.80], [3.40, 0.92], [3.20, 0.98],
    [3.00, 1.00]
  ],
  lmto: [
    [2.70, 0.00], [2.55, 0.15], [2.45, 0.35], [2.35, 0.55],
    [2.25, 0.75], [2.10, 0.92], [1.80, 0.99], [1.50, 1.00]
  ],
  custom: [
    [4.20, 0.00], [3.90, 0.15], [3.70, 0.40], [3.50, 0.70],
    [3.30, 0.90], [3.00, 0.99], [2.50, 1.00]
  ]
};

// 生成知识区HTML
function renderKnowledge() {
  const chemRows = Object.values(BATTERY_CHEMISTRIES).map(c =>
    `<tr>
      <td><strong style="color:${c.color}">${c.name}</strong></td>
      <td>${c.nominalV} V</td>
      <td>${c.chargeV} V</td>
      <td>${c.dischargeMinV} V</td>
      <td>${c.storageV} V</td>
      <td>${c.cycleLife}</td>
      <td>${c.energyDensity}</td>
    </tr>`
  ).join("");

  const consRows = CONSISTENCY_REFERENCE.map(c =>
    `<tr>
      <td><strong>${c.scene}</strong></td>
      <td>${c.capIntraPct}</td>
      <td>${c.resIntraPct}</td>
      <td>${c.capInterPct}</td>
      <td>${c.resInterPct}</td>
      <td style="text-align:left">${c.note}</td>
    </tr>`
  ).join("");

  return `
    <div class="know-grid">
      <div class="know-card">
        <h4>🔋 常见锂电池电压参数</h4>
        <div class="table-wrap">
        <table>
          <thead><tr><th>类型</th><th>标称电压</th><th>满充上限</th><th>最低截止</th><th>存储电压</th><th>循环寿命</th><th>能量密度</th></tr></thead>
          <tbody>${chemRows}</tbody>
        </table>
        </div>
        <div class="tip">⚠️ 满充上限电压不可超过，否则有起火风险；最低截止电压以下继续放电会造成不可逆损伤。</div>
      </div>

      <div class="know-card">
        <h4>📏 不同场景电芯一致性参考</h4>
        <p>组电池前，同串并联内及串间的容量、内阻偏差应控制在合理范围：</p>
        <div class="table-wrap">
        <table>
          <thead><tr><th>使用场景</th><th>单串内容量偏差</th><th>单串内内阻偏差</th><th>串间容量偏差</th><th>串间内阻偏差</th><th>说明</th></tr></thead>
          <tbody>${consRows}</tbody>
        </table>
        </div>
      </div>

      <div class="know-card">
        <h4>📐 串并联计算公式</h4>
        <p><strong>串联 (S)</strong>：电压相加，容量不变</p>
        <p style="margin-left:14px">总电压 = 单电芯电压 × 串数 S</p>
        <p><strong>并联 (P)</strong>：容量相加，电压不变</p>
        <p style="margin-left:14px">总容量 = 单电芯容量 × 并数 P</p>
        <p><strong>总电芯数</strong> = 串数 S × 并数 P</p>
        <p><strong>总能量</strong> = 总电压 × 总容量 (Wh)</p>
        <div class="tip">💡 示例：20串11并 (20S11P) 的三元锂电池，电压 = 3.7×20 = 74V，容量 = 5Ah×11 = 55Ah，总电芯 = 220颗。</div>
      </div>

      <div class="know-card">
        <h4>⚖️ 为什么要分容配对</h4>
        <p><strong>木桶效应</strong>：串联电池组的可用容量由最弱的那一串决定。若某串容量低，该串会先到达截止电压，导致整组无法放出全部容量。</p>
        <p><strong>内阻影响</strong>：并联电芯内阻差异大会导致电流分配不均，内阻低的电芯承担更多电流，发热更大、老化更快。</p>
        <p><strong>配对目标</strong>：</p>
        <p style="margin-left:14px">① 同串（并联）电芯容量、内阻尽量接近</p>
        <p style="margin-left:14px">② 各串（串联）总容量、总内阻尽量接近</p>
        <p style="margin-left:14px">③ 优先保证容量一致性，内阻其次</p>
      </div>

      <div class="know-card">
        <h4>🔌 保护板 (BMS) 常见保护电压</h4>
        <table>
          <thead><tr><th>保护项</th><th>三元锂</th><th>铁锂</th></tr></thead>
          <tbody>
            <tr><td>单节过充保护</td><td>4.25 ± 0.05V</td><td>3.70 ± 0.05V</td></tr>
            <tr><td>单节过充恢复</td><td>4.05 ± 0.05V</td><td>3.40 ± 0.05V</td></tr>
            <tr><td>单节过放保护</td><td>2.50 ± 0.05V</td><td>2.50 ± 0.05V</td></tr>
            <tr><td>单节过放恢复</td><td>3.00 ± 0.05V</td><td>3.00 ± 0.05V</td></tr>
            <tr><td>均衡启动电压</td><td>4.05V ~ 4.15V</td><td>3.45V ~ 3.55V</td></tr>
          </tbody>
        </table>
        <div class="tip">⚠️ 不同厂家保护板参数略有差异，以实际 BMS 规格书为准。</div>
      </div>

      <div class="know-card">
        <h4>🛡️ 使用安全须知</h4>
        <p>1. 组装前务必逐颗测量电压，压差超过 0.1V 的电芯不要直接并联，需先单独充放电均衡。</p>
        <p>2. 焊接时避免长时间高温烫伤电芯，建议用点焊而非电烙铁。</p>
        <p>3. 镍片载流量参考：0.15mm 镍片约 8-10A，大电流组需叠加镍片或用铜排。</p>
        <p>4. 首次充电应在有人看护下进行，并配置合格的保护板与熔断器。</p>
        <p>5. 电芯应存放在干燥阴凉处，远离易燃物，长期不用充至存储电压。</p>
      </div>
    </div>
  `;
}
