/* ============================================================
 * excel.js — Excel 读取与导出（基于 SheetJS）
 * ============================================================ */

const ExcelIO = {

  /* ---------- 智能列名匹配 ----------
   * 在表头中找出 序号/容量/内阻 对应的列
   */
  matchColumns(headers) {
    const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, ""));
    const has = (h, keywords) => keywords.some(k => h.includes(k));

    const colId = { idx: -1, name: null };
    const colCap = { idx: -1, name: null };
    const colRes = { idx: -1, name: null };

    headers.forEach((h, i) => {
      const hn = norm(h);
      if (hn === "") return;
      // 序号
      if (colId.idx < 0 && (has(hn, ["序号", "编号", "id", "no", "number", "cell", "电芯"]) && !has(hn, ["容量", "cap", "内阻", "res", "resist"]))) {
        colId.idx = i; colId.name = h;
      }
      // 内阻（先于容量判断，避免“内阻容量”误判）
      if (colRes.idx < 0 && (has(hn, ["内阻", "res", "resist", "ir", "阻抗", "电阻"]) && !has(hn, ["换算"]))) {
        colRes.idx = i; colRes.name = h;
      }
      // 容量
      if (colCap.idx < 0 && (has(hn, ["容量", "cap", "capacity", "ah", "mah"]) && !has(hn, ["换算", "convert", "内阻"]))) {
        colCap.idx = i; colCap.name = h;
      }
    });

    // 换算容量（可选）
    const colConv = { idx: -1, name: null };
    headers.forEach((h, i) => {
      const hn = norm(h);
      if (colConv.idx < 0 && (hn.includes("换算") || hn.includes("convert") || hn.includes("标准"))) {
        colConv.idx = i; colConv.name = h;
      }
    });

    return { colId, colCap, colRes, colConv };
  },

  /* ---------- 解析 Excel 文件 ----------
   * 返回 { ok, cells, headers, sheetName, warnings, errors }
   */
  parse(arrayBuffer) {
    let workbook;
    try {
      workbook = XLSX.read(arrayBuffer, { type: "array" });
    } catch (e) {
      return { ok: false, error: "文件格式无法解析，请确认是有效的 Excel 文件。" };
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { ok: false, error: "文件中没有工作表。" };
    }

    const warnings = [];
    // 尝试每个 sheet，选第一个能解析出数据的
    for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName];
      // 转为二维数组（保留空单元格）
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
      if (!rows || rows.length === 0) continue;

      // 找表头行：包含"序号"或"容量"或"内阻"的行
      let headerRowIdx = -1;
      let headerRow = null;
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const r = rows[i];
        if (!r) continue;
        const matched = this.matchColumns(r);
        if (matched.colCap.idx >= 0 || matched.colRes.idx >= 0) {
          headerRowIdx = i;
          headerRow = r;
          break;
        }
      }

      // 若没找到明确表头，假设第一行是表头
      if (headerRowIdx < 0) {
        headerRowIdx = 0;
        headerRow = rows[0];
      }

      const cols = this.matchColumns(headerRow);

      // 如果容量和内阻都没找到，跳到下个 sheet
      if (cols.colCap.idx < 0 && cols.colRes.idx < 0) continue;

      // 解析数据行
      const cells = [];
      let autoId = 1;
      const missingRows = [];
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;

        // 跳过全空行
        const hasAny = r.some(v => v !== null && v !== undefined && v !== "");
        if (!hasAny) continue;

        // 序号
        let id = autoId++;
        if (cols.colId.idx >= 0 && r[cols.colId.idx] != null && r[cols.colId.idx] !== "") {
          const parsed = parseInt(r[cols.colId.idx], 10);
          if (!isNaN(parsed)) id = parsed;
        }

        // 容量
        let capacity = null;
        if (cols.colCap.idx >= 0) {
          const v = r[cols.colCap.idx];
          if (v !== null && v !== "" && !isNaN(Number(v))) capacity = Number(v);
        }

        // 内阻
        let resistance = null;
        if (cols.colRes.idx >= 0) {
          const v = r[cols.colRes.idx];
          if (v !== null && v !== "" && !isNaN(Number(v))) resistance = Number(v);
        }

        // 换算容量（可选，保留整数）
        let convCap = null;
        if (cols.colConv.idx >= 0) {
          const v = r[cols.colConv.idx];
          if (v !== null && v !== "" && !isNaN(Number(v))) convCap = Math.round(Number(v));
        }

        if (capacity === null && resistance === null) {
          missingRows.push(i + 1);
          continue;
        }

        cells.push({ id, capacity, resistance, convertedCapacity: convCap });
      }

      if (cells.length === 0) continue;

      // 缺失数据统计
      const missingCap = cells.filter(c => c.capacity === null).length;
      const missingRes = cells.filter(c => c.resistance === null).length;

      if (missingCap > 0) warnings.push(`有 ${missingCap} 颗电芯缺少容量数据`);
      if (missingRes > 0) warnings.push(`有 ${missingRes} 颗电芯缺少内阻数据`);

      return {
        ok: true,
        cells,
        headers: headerRow,
        sheetName,
        colMap: cols,
        warnings,
        missingCap, missingRes
      };
    }

    return {
      ok: false,
      error: "未找到包含「容量」或「内阻」列的工作表，请检查表格格式。"
    };
  },

  /* ---------- 导出解析后的数据为 Excel ---------- */
  exportParsed(cells) {
    const data = [["序号", "容量(mAh)", "内阻(mΩ)", "换算容量(mAh)"]];
    cells.forEach(c => {
      data.push([c.id, c.capacity, c.resistance, c.convertedCapacity || ""]);
    });
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "电芯数据");
    XLSX.writeFile(wb, "电芯数据_" + this._dateStr() + ".xlsx");
  },

  /* ---------- 导出配对表为 Excel ---------- */
  exportPairing(result, packInfo) {
    const data = [];
    // 标题信息
    data.push(["电芯分容配对方案", "", "", "", "", ""]);
    data.push([
      `配置: ${packInfo.s}S${packInfo.p}P | 标称电压: ${packInfo.actualV}V | 容量: ${packInfo.actualCapAh}Ah | 电芯数: ${packInfo.totalCells}`,
      "", "", "", "", ""
    ]);
    data.push([]);

    // 表头
    data.push(["串号", "位置", "电芯序号", "容量(mAh)", "内阻(mΩ)", "备注"]);

    result.strings.forEach((str, si) => {
      str.cells.forEach((cell, ci) => {
        let note = "";
        // 标记超出偏差的电芯
        const capAvg = str.capAvg;
        const resAvg = str.resAvg;
        const capDevPct = capAvg ? Math.abs(cell.capacity - capAvg) / capAvg * 100 : 0;
        const resDevPct = resAvg ? Math.abs(cell.resistance - resAvg) / resAvg * 100 : 0;
        if (capDevPct > 2) note += `容量偏离均值${capDevPct.toFixed(1)}% `;
        if (resDevPct > 15) note += `内阻偏离均值${resDevPct.toFixed(1)}%`;
        data.push([
          `第${str.idx}串`,
          `P${ci + 1}`,
          cell.id,
          cell.capacity,
          cell.resistance,
          note.trim()
        ]);
      });
      // 小计行
      data.push([
        `第${str.idx}串小计`,
        "",
        `${str.count}颗`,
        `均值${str.capAvg.toFixed(1)}`,
        `均值${str.resAvg.toFixed(2)}`,
        `容量偏差${str.capDev.toFixed(2)}% / 内阻偏差${str.resDev.toFixed(2)}%`
      ]);
      data.push(["", "", "", "", "", ""]);
    });

    // 未使用电芯（多余）
    if (result.unused && result.unused.length > 0) {
      data.push([]);
      data.push(["未使用电芯（多余）", "", "", "", "", ""]);
      data.push(["序号", "容量(mAh)", "内阻(mΩ)", "备注", "", ""]);
      result.unused.forEach(cell => {
        data.push([cell.id, cell.capacity, cell.resistance, "未使用", "", ""]);
      });
      data.push([]);
    }

    // 串间统计
    data.push(["串间统计", "", "", "", "", ""]);
    data.push(["串间容量均值", "", "", result.between.capAvg.toFixed(1), "", `偏差${result.between.capDev.toFixed(2)}%`]);
    data.push(["串间内阻均值(串总)", "", "", "", result.between.resSumAvg.toFixed(2), `偏差${result.between.resDev.toFixed(2)}%`]);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "配对方案");
    XLSX.writeFile(wb, `分容配对方案_${packInfo.s}S${packInfo.p}P_${this._dateStr()}.xlsx`);
  },

  _dateStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }
};
