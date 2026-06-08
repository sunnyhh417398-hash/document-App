'use strict';

/**
 * 公文系統 後端伺服器
 * 純 Node.js 標準函式庫實作，無外部相依套件。
 * 提供 REST API 與靜態檔案服務，資料以 JSON 檔案儲存於 data/documents.json。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'documents.json');

// ---- 領域常數 ----------------------------------------------------------------

const DOC_TYPES = ['函', '令', '公告', '簽', '書函', '開會通知單'];
const PRIORITIES = ['普通件', '速件', '最速件'];
const CLASSIFICATIONS = ['普通', '密', '機密', '極機密'];
const DIRECTIONS = ['發文', '收文']; // 收發分流

// 公文狀態流轉。每個狀態可執行的動作 → 目標狀態。
const STATUS = {
  draft: '草稿',
  pending: '陳核中',
  approved: '已核定',
  returned: '已退回',
  dispatched: '已發文',
  archived: '已歸檔',
};

// action -> { from: [...], to, label }
// sign（核章）為會簽多關卡使用，目標狀態依關卡動態決定，故 to 為 null。
const ACTIONS = {
  submit: { from: ['draft', 'returned'], to: 'pending', label: '送核' },
  sign: { from: ['pending'], to: null, label: '核章' },
  approve: { from: ['pending'], to: 'approved', label: '核定' },
  reject: { from: ['pending'], to: 'returned', label: '退回' },
  dispatch: { from: ['approved'], to: 'dispatched', label: '發文' },
  archive: { from: ['dispatched', 'approved'], to: 'archived', label: '歸檔' },
};

// ---- 資料存取層 --------------------------------------------------------------

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || [];
  } catch (err) {
    console.error('讀取資料失敗，回傳空集合：', err.message);
    return [];
  }
}

function writeAll(docs) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(docs, null, 2));
}

// 收發分流文號：收文用「收」、發文用「發」，各自獨立流水號。
// 例：收-115-字第0001號 / 發-115-字第0001號
function nextNumber(docs, direction) {
  const rocYear = new Date().getFullYear() - 1911;
  const prefix = direction === '收文' ? '收' : '發';
  const head = `${prefix}-${rocYear}-`;
  const seq = docs.filter((d) => d.docNumber && d.docNumber.startsWith(head)).length + 1;
  return `${head}字第${String(seq).padStart(4, '0')}號`;
}

function nowISO() {
  return new Date().toISOString();
}

// 整理會簽路徑：每一關卡含單位/職稱與會簽人，並保留簽核結果欄位。
function sanitizeRoute(route) {
  if (!Array.isArray(route)) return [];
  return route
    .filter((s) => s && (String(s.role || '').trim() || String(s.assignee || '').trim()))
    .map((s, i) => ({
      seq: i + 1,
      role: String(s.role || '').trim(),
      assignee: String(s.assignee || '').trim(),
      decision: null, // 'approve' | 'reject' | null
      actor: '',
      note: '',
      at: '',
    }));
}

// ---- 驗證 --------------------------------------------------------------------

function validateDocInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return ['請求內容格式錯誤'];
  }
  if (!body.subject || !String(body.subject).trim()) errors.push('主旨為必填');
  if (body.type && !DOC_TYPES.includes(body.type)) errors.push('公文類別不正確');
  if (body.direction && !DIRECTIONS.includes(body.direction)) errors.push('收發別不正確');
  if (body.priority && !PRIORITIES.includes(body.priority)) errors.push('速別不正確');
  if (body.classification && !CLASSIFICATIONS.includes(body.classification)) {
    errors.push('密等不正確');
  }
  return errors;
}

function sanitizeDoc(body, existing) {
  const base = existing || {};
  const direction = DIRECTIONS.includes(body.direction)
    ? body.direction
    : base.direction || '發文';
  const isIncoming = direction === '收文';
  return {
    direction,
    type: body.type || base.type || '函',
    subject: String(body.subject ?? base.subject ?? '').trim(),
    priority: body.priority || base.priority || '普通件',
    classification: body.classification || base.classification || '普通',
    sender: String(body.sender ?? base.sender ?? '').trim(),
    recipient: String(body.recipient ?? base.recipient ?? '').trim(),
    body: String(body.body ?? base.body ?? '').trim(),
    handler: String(body.handler ?? base.handler ?? '').trim(),
    route: body.route !== undefined ? sanitizeRoute(body.route) : base.route || [],
    // 收文專屬欄位
    incomingFrom: isIncoming ? String(body.incomingFrom ?? base.incomingFrom ?? '').trim() : '',
    incomingNumber: isIncoming ? String(body.incomingNumber ?? base.incomingNumber ?? '').trim() : '',
    incomingDate: isIncoming ? String(body.incomingDate ?? base.incomingDate ?? '').trim() : '',
  };
}

// ---- HTTP 輔助 ---------------------------------------------------------------

function sendJSON(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('請求內容過大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON 解析失敗'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 防止路徑穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 找不到頁面');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---- API 路由 ----------------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'documents', ':id', ...]
  const resource = parts[1];

  // 中繼資料（前端下拉選單用）
  if (resource === 'meta' && req.method === 'GET') {
    return sendJSON(res, 200, {
      docTypes: DOC_TYPES,
      priorities: PRIORITIES,
      classifications: CLASSIFICATIONS,
      directions: DIRECTIONS,
      statuses: STATUS,
      actions: ACTIONS,
    });
  }

  // 統計
  if (resource === 'stats' && req.method === 'GET') {
    const docs = readAll();
    const byStatus = {};
    Object.keys(STATUS).forEach((s) => (byStatus[s] = 0));
    const byDirection = { 發文: 0, 收文: 0 };
    docs.forEach((d) => {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      if (byDirection[d.direction] !== undefined) byDirection[d.direction] += 1;
    });
    return sendJSON(res, 200, { total: docs.length, byStatus, byDirection });
  }

  if (resource !== 'documents') {
    return sendJSON(res, 404, { error: '資源不存在' });
  }

  const id = parts[2];
  const subAction = parts[3]; // 'action'

  // /api/documents
  if (!id) {
    if (req.method === 'GET') {
      let docs = readAll();
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const status = url.searchParams.get('status');
      const type = url.searchParams.get('type');
      const direction = url.searchParams.get('direction');
      if (q) {
        docs = docs.filter((d) =>
          [d.subject, d.docNumber, d.sender, d.recipient, d.handler, d.body, d.incomingFrom]
            .filter(Boolean)
            .some((f) => String(f).toLowerCase().includes(q))
        );
      }
      if (status) docs = docs.filter((d) => d.status === status);
      if (type) docs = docs.filter((d) => d.type === type);
      if (direction) docs = docs.filter((d) => d.direction === direction);
      docs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return sendJSON(res, 200, docs);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const errors = validateDocInput(body);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
      const docs = readAll();
      const clean = sanitizeDoc(body);
      // 收發分流：收文於登記（建立）時即編收文號；發文待「發文」動作時才編發文號。
      const isIncoming = clean.direction === '收文';
      const docNumber = isIncoming ? nextNumber(docs, '收文') : null;
      const doc = {
        id: crypto.randomUUID(),
        docNumber,
        ...clean,
        currentStage: null, // 會簽進行中的關卡索引
        status: 'draft',
        createdAt: nowISO(),
        updatedAt: nowISO(),
        history: [
          {
            action: 'create',
            label: isIncoming ? '收文登記' : '建立草稿',
            actor: clean.handler || '系統',
            note: docNumber ? `編列收文號 ${docNumber}` : '',
            at: nowISO(),
          },
        ],
      };
      docs.push(doc);
      writeAll(docs);
      return sendJSON(res, 201, doc);
    }

    return sendJSON(res, 405, { error: '不支援的方法' });
  }

  // /api/documents/:id
  const docs = readAll();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: '查無此公文' });

  // /api/documents/:id/action  （簽核流程動作）
  if (subAction === 'action' && req.method === 'POST') {
    const body = await readBody(req);
    const actionKey = body.action;
    const def = ACTIONS[actionKey];
    if (!def) return sendJSON(res, 400, { error: '不支援的動作' });

    const doc = docs[idx];
    if (!def.from.includes(doc.status)) {
      return sendJSON(res, 409, {
        error: `目前狀態「${STATUS[doc.status]}」無法執行「${def.label}」`,
      });
    }

    const actor = String(body.actor || '').trim() || '未具名';
    const note = String(body.note || '').trim();
    const hasRoute = Array.isArray(doc.route) && doc.route.length > 0;
    let label = def.label;
    let appliedNote = note;

    switch (actionKey) {
      case 'submit': {
        // 送核：若有會簽路徑，重置各關卡並由第一關開始。
        if (hasRoute) {
          doc.route.forEach((s) => {
            s.decision = null;
            s.actor = '';
            s.note = '';
            s.at = '';
          });
          doc.currentStage = 0;
          label = `送核（會簽 ${doc.route.length} 關）`;
        }
        doc.status = 'pending';
        break;
      }

      case 'sign': {
        // 會簽核章：對目前關卡蓋章後前進；最後一關通過即核定。
        if (!hasRoute) {
          return sendJSON(res, 409, { error: '本公文未設定會簽路徑，請改用「核定」' });
        }
        const i = doc.currentStage ?? 0;
        const stage = doc.route[i];
        stage.decision = 'approve';
        stage.actor = actor;
        stage.note = note;
        stage.at = nowISO();
        const stageName = `第${i + 1}關${stage.role ? `（${stage.role}）` : ''}`;
        if (i >= doc.route.length - 1) {
          doc.status = 'approved';
          doc.currentStage = null;
          label = `${stageName}核章，會簽完成核定`;
        } else {
          doc.currentStage = i + 1;
          label = `${stageName}核章`;
        }
        break;
      }

      case 'approve': {
        if (hasRoute) {
          return sendJSON(res, 409, { error: '本公文採會簽流程，請逐關使用「核章」' });
        }
        doc.status = 'approved';
        break;
      }

      case 'reject': {
        // 退回：會簽中於目前關卡記錄退回。
        if (hasRoute && doc.currentStage != null) {
          const stage = doc.route[doc.currentStage];
          stage.decision = 'reject';
          stage.actor = actor;
          stage.note = note;
          stage.at = nowISO();
          label = `第${doc.currentStage + 1}關退回`;
        }
        doc.currentStage = null;
        doc.status = 'returned';
        break;
      }

      case 'dispatch': {
        // 發文：僅發文公文適用，於此時編列發文號。
        if (doc.direction !== '發文') {
          return sendJSON(res, 409, { error: '僅「發文」公文可執行發文編號' });
        }
        if (!doc.docNumber) {
          doc.docNumber = nextNumber(docs, '發文');
          appliedNote = appliedNote
            ? `${appliedNote}（編列發文號 ${doc.docNumber}）`
            : `編列發文號 ${doc.docNumber}`;
        }
        doc.status = 'dispatched';
        break;
      }

      default: {
        // archive 等單純狀態轉換
        doc.status = def.to;
      }
    }

    doc.updatedAt = nowISO();
    doc.history.push({ action: actionKey, label, actor, note: appliedNote, at: nowISO() });
    writeAll(docs);
    return sendJSON(res, 200, doc);
  }

  if (req.method === 'GET') {
    return sendJSON(res, 200, docs[idx]);
  }

  if (req.method === 'PUT') {
    if (!['draft', 'returned'].includes(docs[idx].status)) {
      return sendJSON(res, 409, { error: '僅草稿或退回的公文可編輯' });
    }
    const body = await readBody(req);
    const errors = validateDocInput({ ...docs[idx], ...body });
    if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
    const clean = sanitizeDoc(body, docs[idx]);
    docs[idx] = { ...docs[idx], ...clean, updatedAt: nowISO() };
    // 草稿階段若切換收發別，重新對應文號（收文即時編號、發文待發文時編號）。
    const cur = docs[idx];
    if (clean.direction === '收文' && (!cur.docNumber || !cur.docNumber.startsWith('收-'))) {
      cur.docNumber = nextNumber(docs, '收文');
    } else if (clean.direction === '發文' && cur.docNumber && cur.docNumber.startsWith('收-')) {
      cur.docNumber = null;
    }
    docs[idx].history.push({ action: 'update', label: '修改內容', actor: clean.handler || '系統', note: '', at: nowISO() });
    writeAll(docs);
    return sendJSON(res, 200, docs[idx]);
  }

  if (req.method === 'DELETE') {
    const [removed] = docs.splice(idx, 1);
    writeAll(docs);
    return sendJSON(res, 200, { deleted: removed.id });
  }

  return sendJSON(res, 405, { error: '不支援的方法' });
}

// ---- 伺服器 ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error('伺服器錯誤：', err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message || '伺服器內部錯誤' });
  }
});

if (require.main === module) {
  ensureStore();
  server.listen(PORT, HOST, () => {
    console.log(`公文系統已啟動： http://localhost:${PORT}`);
  });
}

module.exports = { server, ACTIONS, STATUS, nextNumber };
