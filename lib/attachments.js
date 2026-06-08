'use strict';

/**
 * 附件儲存：檔案實體存於 data/attachments/<docId>/，中繼資料存於公文的 attachments 欄位。
 * 上傳以 base64 dataURL 方式傳入（零外部相依，免處理 multipart）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ATTACH_DIR, ensureDir } = require('./db');

const MAX_BYTES = 10 * 1024 * 1024; // 單檔 10MB

function safeName(name) {
  return String(name || 'file')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 120);
}

// 解析 data:<mime>;base64,<data>
function parseDataURL(dataURL) {
  const m = /^data:([^;]*);base64,(.*)$/s.exec(String(dataURL || ''));
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', buffer: Buffer.from(m[2], 'base64') };
}

function save(docId, filename, dataURL, uploadedBy) {
  const parsed = parseDataURL(dataURL);
  if (!parsed) throw new Error('附件格式錯誤');
  if (parsed.buffer.length === 0) throw new Error('附件內容為空');
  if (parsed.buffer.length > MAX_BYTES) throw new Error('附件超過 10MB 上限');

  const id = crypto.randomUUID();
  const dir = path.join(ATTACH_DIR, docId);
  ensureDir(dir);
  const stored = `${id}_${safeName(filename)}`;
  fs.writeFileSync(path.join(dir, stored), parsed.buffer);

  return {
    id,
    filename: safeName(filename),
    stored,
    mime: parsed.mime,
    size: parsed.buffer.length,
    uploadedBy: uploadedBy || '',
    uploadedAt: new Date().toISOString(),
  };
}

function filePath(docId, meta) {
  return path.join(ATTACH_DIR, docId, meta.stored);
}

function remove(docId, meta) {
  try {
    fs.unlinkSync(filePath(docId, meta));
  } catch (err) {
    /* 檔案不存在則忽略 */
  }
}

function removeAll(docId) {
  const dir = path.join(ATTACH_DIR, docId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* 忽略 */
  }
}

module.exports = { MAX_BYTES, save, filePath, remove, removeAll };
