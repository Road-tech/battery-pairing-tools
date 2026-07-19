/* ============================================================
 * pair.js — 分容配对核心算法
 *
 * 策略：约束贪心(LPT)优先最小化串间容量偏差(木桶效应)，
 *       再用容量保持型局部交换优化串内内阻一致性。
 * ============================================================ */

const Pair = {

  /* ---------- 主配对入口 ----------
   * cells: [{id, capacity, resistance}]
   * s: 串联数, p: 并联数
   * tolerance: {tolCapIn, tolResIn, tolCapBetween, tolResBetween} (%)
   * 返回 { ok, error, strings, between, overall }
   */
  run(cells, s, p, tolerance) {
    const need = s * p;
    if (!cells || cells.length === 0) {
      return { ok: false, error: "没有可用的电芯数据，请先上传并解析。" };
    }
    if (cells.length < need) {
      return {
        ok: false,
        error: "cells_not_enough",
        need, have: cells.length, short: need - cells.length
      };
    }

    // 1. 数据校验：剔除无效项
    const valid = cells.filter(c =>
      c && c.id != null && c.capacity != null && c.resistance != null &&
      !isNaN(c.capacity) && !isNaN(c.resistance) && c.capacity > 0
    );
    if (valid.length < need) {
      const missing = cells.length - valid.length;
      return {
        ok: false,
        error: "cells_invalid",
        total: cells.length, invalid: missing, valid: valid.length, need
      };
    }

    // 2. 标记有效容量：优先使用用户已换算的满放容量(convertedCapacity)，否则用实测容量
    valid.forEach(c => {
      c._cap = (c.convertedCapacity != null && !isNaN(c.convertedCapacity) && c.convertedCapacity > 0)
        ? c.convertedCapacity
        : c.capacity;
    });

    // 3. 按有效容量降序排列
    const sorted = [...valid].sort((a, b) => b._cap - a._cap);

    // 3. 约束贪心分配(LPT)：按容量降序，每颗分配给「当前容量总和最小且未满」的串。
    //    这样能最小化串间容量偏差（木桶效应优先），同时保证每串恰好 P 颗。
    const groups = Array.from({ length: s }, () => []);
    const sums = new Array(s).fill(0);
    const irSums = new Array(s).fill(0);
    for (let i = 0; i < need; i++) {
      const cell = sorted[i];
      // 在未满的串中找容量总和最小者；并列时优先内阻总和最大者(利于均衡内阻)
      let bestIdx = -1, bestSum = Infinity, bestIR = -Infinity;
      for (let g = 0; g < s; g++) {
        if (groups[g].length >= p) continue;
        if (sums[g] < bestSum - 1e-9 || (Math.abs(sums[g] - bestSum) < 1e-9 && irSums[g] > bestIR)) {
          bestSum = sums[g]; bestIR = irSums[g]; bestIdx = g;
        }
      }
      groups[bestIdx].push(cell);
      sums[bestIdx] += cell._cap;
      irSums[bestIdx] += cell.resistance;
    }

    // 4. 容量保持型局部交换：仅在容量差极小的电芯间交换，降低串内内阻偏差
    this._optimize(groups, tolerance);

    // 5. 每串内按有效容量降序排列（展示更直观）
    groups.forEach(g => g.sort((a, b) => b._cap - a._cap));

    // 6. 计算统计
    const strings = groups.map((g, i) => this._stringStats(i + 1, g, tolerance));
    const between = this._betweenStats(strings, tolerance);
    const hasConverted = valid.some(c =>
      c.convertedCapacity != null && !isNaN(c.convertedCapacity) && c.convertedCapacity > 0
    );

    return {
      ok: true,
      mode: "balanced",
      strings,
      between,
      hasConverted,
      total: s * p,
      used: sorted.slice(0, need),
      unused: sorted.slice(need)   // 多余的、未使用电芯
    };
  },

  /* ---------- 单串统计 ---------- */
  _stringStats(idx, cells, tol) {
    // 显示用测量容量(capacity)计算，让用户看到与表格列一致的数据
    const caps = cells.map(c => c.capacity);
    const ress = cells.map(c => c.resistance);
    const cs = Calc.stats(caps);
    const rs = Calc.stats(ress);
    const capDev = cs.devPct;   // 极差/均值 %
    const resDev = rs.devPct;
    return {
      idx, cells,
      count: cells.length,
      capSum: cs.sum,
      capAvg: cs.avg,
      capMax: cs.max, capMin: cs.min, capRange: cs.range,
      capDev,
      resSum: rs.sum,
      resAvg: rs.avg,
      resMax: rs.max, resMin: rs.min, resRange: rs.range,
      resDev,
      capOk: capDev <= tol.tolCapIn,
      resOk: resDev <= tol.tolResIn
    };
  },

  /* ---------- 串间统计 ---------- */
  _betweenStats(strings, tol) {
    const capAvgs = strings.map(s => s.capAvg);
    const resSums = strings.map(s => s.resSum);
    const cs = capAvgs.length ? Calc.stats(capAvgs) : { avg: 0, max: 0, min: 0, devPct: 0 };
    const rs = resSums.length ? Calc.stats(resSums) : { avg: 0, max: 0, min: 0, devPct: 0 };
    return {
      capAvg: cs.avg, capMax: cs.max, capMin: cs.min, capDev: cs.devPct,
      resSumAvg: rs.avg, resSumMax: rs.max, resSumMin: rs.min, resDev: rs.devPct,
      capOk: cs.devPct <= tol.tolCapBetween,
      resOk: rs.devPct <= tol.tolResBetween
    };
  },

  /* ---------- 贪心局部交换优化 ----------
   * 原则：严格保持蛇形分布带来的串间容量均衡（木桶效应优先）。
   * 只在「容量差极小」的电芯之间做交换，仅用于降低串内内阻偏差，
   * 因此串间容量偏差不会被破坏。
   */
  _optimize(groups, tol) {
    const s = groups.length;
    if (!groups[0]) return;
    const P = groups[0].length;
    const total = s * P;
    const allCaps = groups.flat().map(c => c._cap);
    const avgCap = allCaps.reduce((a, b) => a + b, 0) / total;
    // 仅交换容量差 < 1% 均值的电芯，保证容量均衡
    const capThreshold = avgCap * 0.01;

    let improved = true;
    let iter = 0;
    const maxIter = 30;

    while (improved && iter < maxIter) {
      improved = false;
      iter++;
      for (let i = 0; i < s; i++) {
        for (let j = i + 1; j < s; j++) {
          const gi = groups[i], gj = groups[j];
          for (let a = 0; a < gi.length; a++) {
            for (let b = 0; b < gj.length; b++) {
              const ca = gi[a]._cap, cb = gj[b]._cap;
              // 容量差距大则不交换，保持容量均衡
              if (Math.abs(ca - cb) > capThreshold) continue;
              // 评估交换对两组串内内阻偏差的影响
              const before = this._withinResDev(gi) + this._withinResDev(gj);
              const tmpA = gi[a], tmpB = gj[b];
              gi[a] = tmpB; gj[b] = tmpA;
              const after = this._withinResDev(gi) + this._withinResDev(gj);
              if (after < before - 1e-9) {
                improved = true; // 接受交换
              } else {
                gi[a] = tmpA; gj[b] = tmpB; // 还原
              }
            }
          }
        }
      }
    }
  },

  /* 单组内阻偏差率 (%) */
  _withinResDev(group) {
    const rs = Calc.stats(group.map(c => c.resistance));
    return rs.devPct;
  },

  /* ============================================================
   * 模式二：达标优先配对（runStrict）
   * 以「偏差范围」为首要目标：每一串都必须满足
   *   串内容量偏差 ≤ tolCapIn 且 串内内阻偏差 ≤ tolResIn
   * 从第 1 串开始逐串构建，凑不出达标串即停止，返回缺口信息。
   * ============================================================ */
  runStrict(cells, s, p, tolerance) {
    const tol = tolerance || { tolCapIn: 2, tolResIn: 15, tolCapBetween: 1, tolResBetween: 10 };

    if (!cells || cells.length === 0) {
      return { ok: false, error: "没有可用的电芯数据，请先上传并解析。" };
    }

    // 1. 数据校验
    const valid = cells.filter(c =>
      c && c.id != null && c.capacity != null && c.resistance != null &&
      !isNaN(c.capacity) && !isNaN(c.resistance) && c.capacity > 0
    );
    if (valid.length < p) {
      return {
        ok: false, error: "cells_not_enough",
        need: p, have: valid.length, short: p - valid.length
      };
    }

    // 2. 标记有效容量
    valid.forEach(c => {
      c._cap = (c.convertedCapacity != null && !isNaN(c.convertedCapacity) && c.convertedCapacity > 0)
        ? c.convertedCapacity : c.capacity;
    });

    // 3. 按容量降序排列（用于滑动窗口找容量相近的组合）
    const remaining = [...valid].sort((a, b) => b._cap - a._cap);

    // 4. 逐串构建
    const strings = [];
    for (let i = 0; i < s; i++) {
      const group = this._findBestGroup(remaining, p, tol);
      if (!group) break;   // 凑不出达标串，停止
      // 从 remaining 移除已选电芯
      const ids = new Set(group.map(c => c.id));
      for (let j = remaining.length - 1; j >= 0; j--) {
        if (ids.has(remaining[j].id)) remaining.splice(j, 1);
      }
      // 串内按容量降序
      group.sort((a, b) => b._cap - a._cap);
      strings.push(this._stringStats(i + 1, group, tol));
    }

    // 5. 计算缺口与电芯要求（一串都没配上时，基于全部有效电芯给出要求）
    const matched = strings.length;
    const gap = s - matched;
    const gapCells = gap * p;
    const requirement = this._computeRequirement(strings, valid, tol);

    // 6. 串间统计（仅基于已配串）
    const between = this._betweenStats(strings, tol);

    return {
      ok: true,
      mode: "strict",
      strings,
      between,
      hasConverted: valid.some(c =>
        c.convertedCapacity != null && !isNaN(c.convertedCapacity) && c.convertedCapacity > 0
      ),
      matched,
      targetS: s,
      targetP: p,
      gap,            // 缺几串
      gapCells,       // 缺几颗
      requirement,    // 缺口电芯的容量/内阻要求
      full: gap === 0,
      total: matched * p,
      used: strings.flatMap(str => str.cells),
      unused: remaining  // 剩余未使用（未配进任何达标串的电芯）
    };
  },

  /* 在 remaining 中找 P 颗同时满足「容量偏差≤tolCapIn 且 内阻偏差≤tolResIn」的组合
   * 策略：
   *   1. 按容量排序，以每个 i 为起点，扩展出容量偏差达标的最大候选池 [i, j)
   *   2. 在候选池内按内阻排序，滑动找内阻偏差达标的 P 颗
   *   3. 所有候选中选内阻偏差最小者
   * 这样能找到「容量相近 + 内阻相近」的组合，而非仅容量连续（内阻随机）的窗口。
   */
  _findBestGroup(remaining, p, tol) {
    if (remaining.length < p) return null;
    const sorted = [...remaining].sort((a, b) => a._cap - b._cap);  // 容量升序
    let best = null;
    let bestScore = Infinity;

    for (let i = 0; i <= sorted.length - p; i++) {
      // 起始 p 颗就检查容量偏差
      const initWin = sorted.slice(i, i + p);
      const initAvg = initWin.reduce((a, b) => a + b._cap, 0) / p;
      const initDev = initAvg ? (initWin[p - 1]._cap - initWin[0]._cap) / initAvg * 100 : 0;
      if (initDev > tol.tolCapIn) continue;   // 起始就超标，跳过

      // 扩展右边界 j，直到容量偏差超标
      let j = i + p;
      while (j < sorted.length) {
        const win = sorted.slice(i, j + 1);
        const cAvg = win.reduce((a, b) => a + b._cap, 0) / win.length;
        const capDev = cAvg ? (sorted[j]._cap - sorted[i]._cap) / cAvg * 100 : 0;
        if (capDev > tol.tolCapIn) break;
        j++;
      }
      // 候选池 [i, j)（j 是第一个超标位置或末尾）
      const pool = sorted.slice(i, j);
      if (pool.length < p) continue;

      // 在候选池内按内阻排序，滑动找内阻达标的 P 颗
      const byRes = [...pool].sort((a, b) => a.resistance - b.resistance);
      for (let k = 0; k <= byRes.length - p; k++) {
        const win = byRes.slice(k, k + p);
        const rs = Calc.stats(win.map(c => c.resistance));
        if (rs.devPct > tol.tolResIn) continue;
        if (rs.devPct < bestScore) {
          bestScore = rs.devPct;
          best = win;
        }
      }
    }
    return best;
  },

  /* 计算缺口电芯的要求范围
   * 基于已配串的容量/内阻分布，给出「还需要的电芯」的容量区间与内阻区间。
   * - 若已配串数≥1：以所有已配电芯的均值为基准，按容差给出区间
   * - 若一串都没配上：以全部有效电芯的均值为基准
   */
  _computeRequirement(strings, allValid, tol) {
    let caps, ress;
    if (strings.length > 0) {
      const all = strings.flatMap(str => str.cells);
      caps = all.map(c => c.capacity);
      ress = all.map(c => c.resistance);
    } else {
      // 一串都没配上，用全部有效电芯作为基准
      caps = allValid.map(c => c.capacity);
      ress = allValid.map(c => c.resistance);
    }
    const cs = caps.length ? Calc.stats(caps) : { avg: 0, min: 0, max: 0, devPct: 0 };
    const rs = ress.length ? Calc.stats(ress) : { avg: 0, min: 0, max: 0, devPct: 0 };
    const capAvg = cs.avg || 0;
    const resAvg = rs.avg || 0;
    // 满足偏差的容量/内阻区间
    const capLo = Math.round(capAvg * (1 - tol.tolCapIn / 100));
    const capHi = Math.round(capAvg * (1 + tol.tolCapIn / 100));
    const resLo = +(resAvg * (1 - tol.tolResIn / 100)).toFixed(1);
    const resHi = +(resAvg * (1 + tol.tolResIn / 100)).toFixed(1);
    return {
      capAvg: Math.round(capAvg),
      capLo, capHi,
      resAvg: +resAvg.toFixed(2),
      resLo, resHi,
      tolCapIn: tol.tolCapIn,
      tolResIn: tol.tolResIn
    };
  }
};
