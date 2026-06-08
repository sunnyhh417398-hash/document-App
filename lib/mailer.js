'use strict';

/**
 * 寄信模組（零外部相依）。
 * 若設定 SMTP 環境變數則透過 SMTP 寄出；否則（或寄送失敗時）將郵件寫入
 * data/outbox/ 作為 .eml 檔，確保在任何環境皆可運作且可稽核。
 *
 * 可用環境變數：
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE(true=隱式TLS), MAIL_FROM
 */

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ensureDir } = require('./db');

const OUTBOX = path.join(DATA_DIR, 'outbox');
const FROM = process.env.MAIL_FROM || 'no-reply@document-app.local';

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// RFC 2047 編碼標頭（支援中文）
function encodeHeader(s) {
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s;
}

function buildMessage({ to, subject, text }) {
  const date = new Date().toUTCString();
  const id = `${crypto.randomUUID()}@document-app.local`;
  return [
    `From: ${FROM}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
}

function writeOutbox(message) {
  ensureDir(OUTBOX);
  const file = path.join(OUTBOX, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.eml`);
  fs.writeFileSync(file, message);
  return { delivered: false, queued: true, file };
}

// 極簡 SMTP 客戶端（best-effort）。成功 resolve，失敗 reject。
function smtpSend({ to, message }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT, 10) || 25;
    const secure = process.env.SMTP_SECURE === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    const socket = secure ? tls.connect({ host, port }) : net.connect({ host, port });
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('SMTP 逾時')); });

    const steps = [];
    steps.push({ expect: 220, cmd: `EHLO document-app.local` });
    if (user && pass) {
      steps.push({ expect: 250, cmd: 'AUTH LOGIN' });
      steps.push({ expect: 334, cmd: b64(user) });
      steps.push({ expect: 334, cmd: b64(pass) });
      steps.push({ expect: 235, cmd: `MAIL FROM:<${FROM}>` });
    } else {
      steps.push({ expect: 250, cmd: `MAIL FROM:<${FROM}>` });
    }
    steps.push({ expect: 250, cmd: `RCPT TO:<${to}>` });
    steps.push({ expect: 250, cmd: 'DATA' });
    steps.push({ expect: 354, cmd: message + '\r\n.' });
    steps.push({ expect: 250, cmd: 'QUIT' });

    let i = -1;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      if (!/\r\n$/.test(buf)) return;
      const code = parseInt(buf.slice(0, 3), 10);
      const step = steps[i];
      buf = '';
      if (step && code !== step.expect && !(i === -1 && code === 220)) {
        socket.destroy();
        return reject(new Error(`SMTP 非預期回應：${code}`));
      }
      i += 1;
      if (i >= steps.length) { socket.end(); return resolve({ delivered: true }); }
      socket.write(steps[i].cmd + '\r\n');
    });
    socket.on('error', reject);
    socket.on('end', () => { if (i >= steps.length - 1) resolve({ delivered: true }); });
  });
}

// 對外：永不拋出例外，回傳寄送結果
async function sendMail({ to, subject, text }) {
  if (!to) return { delivered: false, skipped: true };
  const message = buildMessage({ to, subject, text });
  if (process.env.SMTP_HOST) {
    try {
      const r = await smtpSend({ to, message });
      return r;
    } catch (err) {
      console.warn('SMTP 寄送失敗，改寫入 outbox：', err.message);
      return writeOutbox(message);
    }
  }
  return writeOutbox(message);
}

module.exports = { sendMail, OUTBOX };
