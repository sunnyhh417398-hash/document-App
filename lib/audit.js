'use strict';

/**
 * 系統稽核軌跡：記錄登入、公文異動與簽核等重要操作，可匯出為 CSV。
 */

const path = require('path');
const { DATA_DIR, readJSON, writeJSON } = require('./db');

const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES = 10000;

function all() {
  return readJSON(AUDIT_FILE, []);
}

function log(entry) {
  const list = all();
  list.push({ at: new Date().toISOString(), ...entry });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  writeJSON(AUDIT_FILE, list);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function csvCell(v) {
  v = v == null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function toCSV(rows) {
  const headers = ['時間', '操作者', '角色', '動作', '對象文號', '對象主旨', '說明', '來源IP'];
  const keys = ['actor', 'role', 'action', 'docNumber', 'subject', 'detail', 'ip'];
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    const cells = [csvCell(fmtTime(r.at))].concat(keys.map((k) => csvCell(r[k])));
    lines.push(cells.join(','));
  });
  // 加上 BOM 讓 Excel 正確辨識 UTF-8 中文
  return '﻿' + lines.join('\r\n');
}

module.exports = { all, log, toCSV, fmtTime };
