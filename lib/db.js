'use strict';

/**
 * 共用的 JSON 檔案儲存層（零外部相依）。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  ensureDir(DATA_DIR);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = { DATA_DIR, ATTACH_DIR, ensureDir, readJSON, writeJSON };
