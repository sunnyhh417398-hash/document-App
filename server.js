'use strict';

/**
 * 公文系統 後端伺服器
 * 純 Node.js 標準函式庫實作，無外部相依套件。
 * 功能：公文製作、收發分流、會簽多關卡、登入權限分級、附件上傳、稽核軌跡。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const db = require('./lib/db');
const auth = require('./lib/auth');
const audit = require('./lib/audit');
const attachments = require('./lib/attachments');
const templates = require('./lib/templates');
const notifications = require('./lib/notifications');
const mailer = require('./lib/mailer');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_FILE = path.join(db.DATA_DIR, 'documents.json');

// ---- 領域常數 ----------------------------------------------------------------

const DOC_TYPES = ['函', '令', '公告', '簽', '書函', '開會通知單'];
const PRIORITIES = ['普通件', '速件', '最速件'];
const CLASSIFICATIONS = ['普通', '密', '機密', '極機密'];
const DIRECTIONS = ['發文', '收文'];

const STATUS = {
  draft: '草稿',
  pending: '陳核中',
  approved: '已核定',
  returned: '已退回',
  dispatched: '已發文',
  archived: '已歸檔',
};

const ACTIONS = {
  submit: { from: ['draft', 'returned'], to: 'pending', label: '送核' },
  sign: { from: ['pending'], to: null, label: '核章' },
  approve: { from: ['pending'], to: 'approved', label: '核定' },
  reject: { from: ['pending'], to: 'returned', label: '退回' },
  dispatch: { from: ['approved'], to: 'dispatched', label: '發文' },
  archive: { from: ['dispatched', 'approved'], to: 'archived', label: '歸檔' },
};

// 動作 → 所需權限
const ACTION_CAP = {
  submit: 'submit', sign: 'sign', approve: 'approve',
  reject: 'reject', dispatch: 'dispatch', archive: 'archive',
};

// ---- 資料存取層 --------------------------------------------------------------

const readAll = () => db.readJSON(DOCS_FILE, []) || [];
const writeAll = (docs) => db.writeJSON(DOCS_FILE, docs);

function nextNumber(docs, direction) {
  const rocYear = new Date().getFullYear() - 1911;
  const prefix = direction === '收文' ? '收' : '發';
  const head = `${prefix}-${rocYear}-`;
  const seq = docs.filter((d) => d.docNumber && d.docNumber.startsWith(head)).length + 1;
  return `${head}字第${String(seq).padStart(4, '0')}號`;
}

const nowISO = () => new Date().toISOString();

// ---- 限辦日期 / 逾期計算 ----
const CLOSED_STATUS = ['dispatched', 'archived']; // 已結案，不再計逾期
const DUE_SOON_DAYS = 3;

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 回傳 'overdue' | 'soon' | 'none'（YYYY-MM-DD 字串可直接字典序比較）
function dueState(doc, today) {
  if (!doc.dueDate || CLOSED_STATUS.includes(doc.status)) return 'none';
  if (doc.dueDate < today) return 'overdue';
  if (doc.dueDate <= addDays(today, DUE_SOON_DAYS)) return 'soon';
  return 'none';
}

function withDueState(doc, today) {
  return { ...doc, dueState: dueState(doc, today) };
}

function sanitizeRoute(route) {
  if (!Array.isArray(route)) return [];
  return route
    .filter((s) => s && (String(s.role || '').trim() || String(s.assignee || '').trim()))
    .map((s, i) => ({
      seq: i + 1,
      role: String(s.role || '').trim(),
      assignee: String(s.assignee || '').trim(),
      decision: null,
      actor: '',
      note: '',
      at: '',
    }));
}

// ---- 驗證 --------------------------------------------------------------------

function validateDocInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['請求內容格式錯誤'];
  if (!body.subject || !String(body.subject).trim()) errors.push('主旨為必填');
  if (body.type && !DOC_TYPES.includes(body.type)) errors.push('公文類別不正確');
  if (body.direction && !DIRECTIONS.includes(body.direction)) errors.push('收發別不正確');
  if (body.priority && !PRIORITIES.includes(body.priority)) errors.push('速別不正確');
  if (body.classification && !CLASSIFICATIONS.includes(body.classification)) errors.push('密等不正確');
  if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate))) errors.push('限辦日期格式不正確');
  return errors;
}

function sanitizeDoc(body, existing) {
  const base = existing || {};
  const direction = DIRECTIONS.includes(body.direction) ? body.direction : base.direction || '發文';
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
    dueDate: String(body.dueDate ?? base.dueDate ?? '').trim(),
    route: body.route !== undefined ? sanitizeRoute(body.route) : base.route || [],
    incomingFrom: isIncoming ? String(body.incomingFrom ?? base.incomingFrom ?? '').trim() : '',
    incomingNumber: isIncoming ? String(body.incomingNumber ?? base.incomingNumber ?? '').trim() : '',
    incomingDate: isIncoming ? String(body.incomingDate ?? base.incomingDate ?? '').trim() : '',
  };
}

// ---- HTTP 輔助 ---------------------------------------------------------------

function sendJSON(res, statusCode, payload, extraHeaders) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  }, extraHeaders || {}));
  res.end(data);
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('請求內容過大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('JSON 解析失敗')); }
    });
    req.on('error', reject);
  });
}

function clientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// 站內通知 + Email（best-effort，不阻斷主流程）
function notifyUsers(users, title, body, doc) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) return;
  notifications.add(list.map((u) => u.id), { title, body, docId: doc ? doc.id : null });
  list.forEach((u) => {
    if (u.email) {
      mailer.sendMail({ to: u.email, subject: `【公文系統】${title}`, text: `${body}\n\n公文：${doc ? doc.subject : ''}` })
        .catch(() => { /* 已於 mailer 內處理 */ });
    }
  });
}

// 全文檢索：彙整公文各欄位（含會簽、歷程、附件名）為檢索字串
function haystack(d) {
  const parts = [
    d.subject, d.docNumber, d.sender, d.recipient, d.handler, d.body,
    d.incomingFrom, d.incomingNumber, d.type, d.direction,
  ];
  (d.route || []).forEach((s) => parts.push(s.role, s.assignee, s.note));
  (d.history || []).forEach((h) => parts.push(h.label, h.note, h.actor));
  (d.attachments || []).forEach((a) => parts.push(a.filename));
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function recordAudit(req, user, action, doc, detail) {
  audit.log({
    actor: user ? user.name : '訪客',
    role: user ? auth.ROLES[user.role] : '',
    action,
    docNumber: doc ? doc.docNumber || '' : '',
    subject: doc ? doc.subject || '' : '',
    detail: detail || '',
    ip: clientIP(req),
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
  const rel = pathname === '/' ? '/index.html' : pathname;
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

function canEdit(doc, user) {
  return user.role === 'admin' || doc.createdBy === user.id;
}

// ---- 身分驗證路由（公開）-----------------------------------------------------

async function handleAuthRoutes(req, res, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[1];

  if (resource === 'login' && req.method === 'POST') {
    const body = await readBody(req);
    const u = auth.findByUsername(String(body.username || '').trim());
    if (!u || !auth.verifyPassword(body.password, u.password)) {
      recordAudit(req, u ? auth.publicUser(u) : null, '登入失敗', null, `帳號：${body.username || ''}`);
      // 附帶診斷：目前帳號總數與是否找到該帳號（協助排查資料未初始化）
      const accounts = (auth.loadUsers() || []).length;
      return sendJSON(res, 401, { error: '帳號或密碼錯誤', accounts, found: !!u });
    }
    if (u.active === false) {
      recordAudit(req, auth.publicUser(u), '登入遭拒', null, '帳號已停用');
      return sendJSON(res, 403, { error: '帳號已停用，請聯絡管理員' });
    }
    const token = auth.createSession(u);
    recordAudit(req, auth.publicUser(u), '登入成功', null, '');
    const cookie = `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`;
    // 同時回傳 token，前端以 Authorization 標頭帶入後續請求（不依賴 Cookie）
    return sendJSON(res, 200, Object.assign(auth.publicUser(u), { token }), { 'Set-Cookie': cookie });
  }

  if (resource === 'logout' && req.method === 'POST') {
    recordAudit(req, user, '登出', null, '');
    auth.destroySession(auth.tokenFromReq(req));
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (resource === 'me' && req.method === 'GET') {
    if (!user) return sendJSON(res, 401, { error: '未登入' });
    return sendJSON(res, 200, user);
  }

  // 使用者自行修改密碼
  if (resource === 'me' && parts[2] === 'password' && req.method === 'POST') {
    if (!user) return sendJSON(res, 401, { error: '未登入' });
    const body = await readBody(req);
    const full = auth.findById(user.id);
    if (!full || !auth.verifyPassword(body.currentPassword, full.password)) {
      return sendJSON(res, 400, { error: '目前密碼錯誤' });
    }
    if (!body.newPassword || String(body.newPassword).length < 6) {
      return sendJSON(res, 400, { error: '新密碼至少 6 碼' });
    }
    const users = auth.loadUsers();
    const u = users.find((x) => x.id === user.id);
    u.password = auth.hashPassword(body.newPassword);
    u.updatedAt = nowISO();
    auth.saveUsers(users);
    recordAudit(req, user, '修改自己的密碼', null, '');
    return sendJSON(res, 200, { ok: true });
  }

  return null; // 非身分路由
}

// ---- 使用者管理路由（管理員）------------------------------------------------

const VALID_ROLES = Object.keys(auth.ROLES);

async function handleUserRoutes(req, res, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'users') return null;
  if (!auth.can(user, 'users')) return sendJSON(res, 403, { error: '權限不足' });

  const id = parts[2];
  const sub = parts[3]; // 'password'

  // /api/users
  if (!id) {
    if (req.method === 'GET') {
      return sendJSON(res, 200, (auth.loadUsers() || []).map(auth.listUser));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const name = String(body.name || '').trim();
      const role = body.role;
      if (!username || !name) return sendJSON(res, 400, { error: '帳號與姓名為必填' });
      if (!VALID_ROLES.includes(role)) return sendJSON(res, 400, { error: '角色不正確' });
      if (!body.password || String(body.password).length < 6) return sendJSON(res, 400, { error: '密碼至少 6 碼' });
      if (auth.usernameExists(username)) return sendJSON(res, 409, { error: '帳號已存在' });
      const users = auth.loadUsers() || [];
      const u = {
        id: crypto.randomUUID(), username, name, role,
        email: String(body.email || '').trim(),
        password: auth.hashPassword(body.password),
        active: true, createdAt: nowISO(),
      };
      users.push(u);
      auth.saveUsers(users);
      recordAudit(req, user, '新增使用者', null, `${name}（${username}/${auth.ROLES[role]}）`);
      return sendJSON(res, 201, auth.listUser(u));
    }
    return sendJSON(res, 405, { error: '不支援的方法' });
  }

  // /api/users/:id
  const users = auth.loadUsers() || [];
  const target = users.find((u) => u.id === id);
  if (!target) return sendJSON(res, 404, { error: '查無此使用者' });

  // 重設密碼
  if (sub === 'password' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.password || String(body.password).length < 6) return sendJSON(res, 400, { error: '密碼至少 6 碼' });
    target.password = auth.hashPassword(body.password);
    target.updatedAt = nowISO();
    auth.saveUsers(users);
    auth.destroyUserSessions(target.id); // 強制重新登入
    recordAudit(req, user, '重設密碼', null, `${target.name}（${target.username}）`);
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    const newRole = body.role !== undefined ? body.role : target.role;
    const newActive = body.active !== undefined ? !!body.active : target.active !== false;
    if (!VALID_ROLES.includes(newRole)) return sendJSON(res, 400, { error: '角色不正確' });
    // 防呆：不可停用或降級自己
    if (target.id === user.id && (newActive === false || newRole !== 'admin')) {
      return sendJSON(res, 409, { error: '不可停用或變更自己的管理員身分' });
    }
    // 防呆：保留至少一名可登入的管理員
    const losingAdmin = target.role === 'admin' && (newRole !== 'admin' || newActive === false);
    if (losingAdmin && auth.activeAdminCount(target.id) === 0) {
      return sendJSON(res, 409, { error: '系統須保留至少一名啟用中的管理員' });
    }
    const roleChanged = newRole !== target.role;
    const deactivated = target.active !== false && newActive === false;
    if (body.name !== undefined) target.name = String(body.name).trim() || target.name;
    if (body.email !== undefined) target.email = String(body.email).trim();
    target.role = newRole;
    target.active = newActive;
    target.updatedAt = nowISO();
    auth.saveUsers(users);
    if (roleChanged || deactivated) auth.destroyUserSessions(target.id);
    recordAudit(req, user, '更新使用者', null,
      `${target.name}（${target.username}）→ ${auth.ROLES[newRole]} / ${newActive ? '啟用' : '停用'}`);
    return sendJSON(res, 200, auth.listUser(target));
  }

  if (req.method === 'DELETE') {
    if (target.id === user.id) return sendJSON(res, 409, { error: '不可刪除自己的帳號' });
    if (target.role === 'admin' && auth.activeAdminCount(target.id) === 0) {
      return sendJSON(res, 409, { error: '系統須保留至少一名啟用中的管理員' });
    }
    auth.saveUsers(users.filter((u) => u.id !== id));
    auth.destroyUserSessions(target.id);
    recordAudit(req, user, '刪除使用者', null, `${target.name}（${target.username}）`);
    return sendJSON(res, 200, { deleted: id });
  }

  return sendJSON(res, 405, { error: '不支援的方法' });
}

// ---- 公文範本路由 ------------------------------------------------------------

function sanitizeTemplate(body, base) {
  base = base || {};
  const direction = DIRECTIONS.includes(body.direction) ? body.direction : base.direction || '發文';
  return {
    name: String(body.name ?? base.name ?? '').trim(),
    direction,
    type: DOC_TYPES.includes(body.type) ? body.type : base.type || '函',
    priority: PRIORITIES.includes(body.priority) ? body.priority : base.priority || '普通件',
    classification: CLASSIFICATIONS.includes(body.classification) ? body.classification : base.classification || '普通',
    subjectTpl: String(body.subjectTpl ?? base.subjectTpl ?? '').trim(),
    bodyTpl: String(body.bodyTpl ?? base.bodyTpl ?? '').trim(),
    route: sanitizeRoute(body.route !== undefined ? body.route : base.route || []),
  };
}

async function handleTemplateRoutes(req, res, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'templates') return null;
  const id = parts[2];

  if (!id && req.method === 'GET') {
    return sendJSON(res, 200, templates.all());
  }

  // 範本為全機關共用資產，建立 / 修改 / 刪除限管理員
  if (user.role !== 'admin') return sendJSON(res, 403, { error: '範本管理限管理員' });

  if (!id && req.method === 'POST') {
    const body = await readBody(req);
    const clean = sanitizeTemplate(body);
    if (!clean.name) return sendJSON(res, 400, { error: '範本名稱為必填' });
    const list = templates.all();
    const tpl = { id: crypto.randomUUID(), ...clean, createdAt: nowISO() };
    list.push(tpl);
    templates.save(list);
    recordAudit(req, user, '新增公文範本', null, clean.name);
    return sendJSON(res, 201, tpl);
  }

  const list = templates.all();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: '查無此範本' });

  if (req.method === 'PUT') {
    const body = await readBody(req);
    const clean = sanitizeTemplate(body, list[idx]);
    if (!clean.name) return sendJSON(res, 400, { error: '範本名稱為必填' });
    list[idx] = { ...list[idx], ...clean };
    templates.save(list);
    recordAudit(req, user, '修改公文範本', null, clean.name);
    return sendJSON(res, 200, list[idx]);
  }

  if (req.method === 'DELETE') {
    const [removed] = list.splice(idx, 1);
    templates.save(list);
    recordAudit(req, user, '刪除公文範本', null, removed.name);
    return sendJSON(res, 200, { deleted: id });
  }

  return sendJSON(res, 405, { error: '不支援的方法' });
}

// ---- 通知路由 ----------------------------------------------------------------

async function handleNotificationRoutes(req, res, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'notifications') return null;

  if (!parts[2] && req.method === 'GET') {
    return sendJSON(res, 200, {
      unread: notifications.unread(user.id),
      items: notifications.forUser(user.id, 50),
    });
  }

  if (parts[2] === 'read' && req.method === 'POST') {
    const body = await readBody(req);
    const count = notifications.markRead(user.id, Array.isArray(body.ids) ? body.ids : null);
    return sendJSON(res, 200, { marked: count, unread: notifications.unread(user.id) });
  }

  return sendJSON(res, 404, { error: '資源不存在' });
}

// ---- 稽核路由（管理員）-------------------------------------------------------

function handleAuditRoutes(req, res, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'audit') return null;
  if (!auth.can(user, 'audit')) return sendJSON(res, 403, { error: '權限不足' });

  if (parts[2] === 'export' && req.method === 'GET') {
    const csv = audit.toCSV(audit.all());
    recordAudit(req, user, '匯出稽核軌跡', null, `共 ${audit.all().length} 筆`);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${stamp}.csv"`,
    });
    return res.end(Buffer.from(csv, 'utf8'));
  }

  if (!parts[2] && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 200, 1000);
    const rows = audit.all().slice(-limit).reverse();
    return sendJSON(res, 200, rows);
  }

  return sendJSON(res, 404, { error: '資源不存在' });
}

// ---- 公文與附件路由 ----------------------------------------------------------

async function handleApi(req, res, url) {
  const user = auth.currentUser(req);
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[1];

  // 公開身分路由
  const authHandled = await handleAuthRoutes(req, res, url, user);
  if (authHandled !== null) return authHandled;

  // 其餘一律需登入
  if (!user) return sendJSON(res, 401, { error: '請先登入' });

  // 稽核
  if (resource === 'audit') return handleAuditRoutes(req, res, url, user);

  // 使用者管理
  if (resource === 'users') return handleUserRoutes(req, res, url, user);

  // 公文範本
  if (resource === 'templates') return handleTemplateRoutes(req, res, url, user);

  // 站內通知
  if (resource === 'notifications') return handleNotificationRoutes(req, res, url, user);

  if (resource === 'meta' && req.method === 'GET') {
    return sendJSON(res, 200, {
      docTypes: DOC_TYPES, priorities: PRIORITIES, classifications: CLASSIFICATIONS,
      directions: DIRECTIONS, statuses: STATUS, actions: ACTIONS, roles: auth.ROLES,
    });
  }

  if (resource === 'stats' && req.method === 'GET') {
    const docs = readAll();
    const byStatus = {};
    Object.keys(STATUS).forEach((s) => (byStatus[s] = 0));
    const byDirection = { 發文: 0, 收文: 0 };
    const today = todayStr();
    let overdue = 0;
    let soon = 0;
    docs.forEach((d) => {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      if (byDirection[d.direction] !== undefined) byDirection[d.direction] += 1;
      const ds = dueState(d, today);
      if (ds === 'overdue') overdue += 1;
      else if (ds === 'soon') soon += 1;
    });
    return sendJSON(res, 200, { total: docs.length, byStatus, byDirection, overdue, soon });
  }

  if (resource !== 'documents') return sendJSON(res, 404, { error: '資源不存在' });

  const id = parts[2];
  const sub = parts[3];   // 'action' | 'attachments'
  const sub2 = parts[4];  // attachmentId

  // /api/documents
  if (!id) {
    if (req.method === 'GET') {
      let docs = readAll();
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const status = url.searchParams.get('status');
      const type = url.searchParams.get('type');
      const direction = url.searchParams.get('direction');
      if (q) {
        // 全文檢索：多關鍵字以空白分隔，須全部命中（AND）
        const terms = q.split(/\s+/).filter(Boolean);
        docs = docs.filter((d) => {
          const hay = haystack(d);
          return terms.every((t) => hay.includes(t));
        });
      }
      if (status) docs = docs.filter((d) => d.status === status);
      if (type) docs = docs.filter((d) => d.type === type);
      if (direction) docs = docs.filter((d) => d.direction === direction);
      const today = todayStr();
      docs = docs.map((d) => withDueState(d, today));
      const due = url.searchParams.get('due'); // 'overdue' | 'soon'
      if (due === 'overdue') docs = docs.filter((d) => d.dueState === 'overdue');
      else if (due === 'soon') docs = docs.filter((d) => d.dueState === 'soon');
      docs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return sendJSON(res, 200, docs);
    }

    if (req.method === 'POST') {
      if (!auth.can(user, 'create')) return sendJSON(res, 403, { error: '權限不足，無法建立公文' });
      const body = await readBody(req);
      const errors = validateDocInput(body);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
      const docs = readAll();
      const clean = sanitizeDoc(body);
      if (!clean.handler) clean.handler = user.name;
      const isIncoming = clean.direction === '收文';
      const docNumber = isIncoming ? nextNumber(docs, '收文') : null;
      const doc = {
        id: crypto.randomUUID(),
        docNumber,
        ...clean,
        currentStage: null,
        status: 'draft',
        attachments: [],
        createdBy: user.id,
        owner: user.name,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        history: [{
          action: 'create',
          label: isIncoming ? '收文登記' : '建立草稿',
          actor: user.name,
          note: docNumber ? `編列收文號 ${docNumber}` : '',
          at: nowISO(),
        }],
      };
      docs.push(doc);
      writeAll(docs);
      recordAudit(req, user, isIncoming ? '收文登記' : '建立公文', doc, '');
      return sendJSON(res, 201, withDueState(doc, todayStr()));
    }

    return sendJSON(res, 405, { error: '不支援的方法' });
  }

  // /api/documents/:id
  const docs = readAll();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: '查無此公文' });
  const doc = docs[idx];

  // ---- 附件 /api/documents/:id/attachments[/:attId] ----
  if (sub === 'attachments') {
    if (!sub2 && req.method === 'POST') {
      if (!auth.can(user, 'attach')) return sendJSON(res, 403, { error: '權限不足，無法上傳附件' });
      if (doc.status === 'archived') return sendJSON(res, 409, { error: '已歸檔公文不可新增附件' });
      const body = await readBody(req, attachments.MAX_BYTES * 2);
      let meta;
      try {
        meta = attachments.save(doc.id, body.filename, body.data, user.name);
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }
      doc.attachments = doc.attachments || [];
      doc.attachments.push(meta);
      doc.updatedAt = nowISO();
      doc.history.push({ action: 'attach', label: '上傳附件', actor: user.name, note: meta.filename, at: nowISO() });
      writeAll(docs);
      recordAudit(req, user, '上傳附件', doc, meta.filename);
      return sendJSON(res, 201, meta);
    }

    const meta = (doc.attachments || []).find((a) => a.id === sub2);
    if (!meta) return sendJSON(res, 404, { error: '查無此附件' });

    if (req.method === 'GET') {
      const fp = attachments.filePath(doc.id, meta);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: '附件檔案不存在' });
      res.writeHead(200, {
        'Content-Type': meta.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
        'Content-Length': meta.size,
      });
      return fs.createReadStream(fp).pipe(res);
    }

    if (req.method === 'DELETE') {
      if (!canEdit(doc, user)) return sendJSON(res, 403, { error: '僅承辦人或管理員可刪除附件' });
      attachments.remove(doc.id, meta);
      doc.attachments = doc.attachments.filter((a) => a.id !== sub2);
      doc.updatedAt = nowISO();
      doc.history.push({ action: 'detach', label: '刪除附件', actor: user.name, note: meta.filename, at: nowISO() });
      writeAll(docs);
      recordAudit(req, user, '刪除附件', doc, meta.filename);
      return sendJSON(res, 200, { deleted: sub2 });
    }

    return sendJSON(res, 405, { error: '不支援的方法' });
  }

  // ---- 簽核流程 /api/documents/:id/action ----
  if (sub === 'action' && req.method === 'POST') {
    const body = await readBody(req);
    const actionKey = body.action;
    const def = ACTIONS[actionKey];
    if (!def) return sendJSON(res, 400, { error: '不支援的動作' });
    if (!auth.can(user, ACTION_CAP[actionKey])) {
      return sendJSON(res, 403, { error: `您的角色無「${def.label}」權限` });
    }
    if (!def.from.includes(doc.status)) {
      return sendJSON(res, 409, { error: `目前狀態「${STATUS[doc.status]}」無法執行「${def.label}」` });
    }

    const actor = String(body.actor || '').trim() || user.name;
    const note = String(body.note || '').trim();
    const hasRoute = Array.isArray(doc.route) && doc.route.length > 0;
    let label = def.label;
    let appliedNote = note;

    switch (actionKey) {
      case 'submit': {
        if (hasRoute) {
          doc.route.forEach((s) => { s.decision = null; s.actor = ''; s.note = ''; s.at = ''; });
          doc.currentStage = 0;
          label = `送核（會簽 ${doc.route.length} 關）`;
        }
        doc.status = 'pending';
        break;
      }
      case 'sign': {
        if (!hasRoute) return sendJSON(res, 409, { error: '本公文未設定會簽路徑，請改用「核定」' });
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
        if (hasRoute) return sendJSON(res, 409, { error: '本公文採會簽流程，請逐關使用「核章」' });
        doc.status = 'approved';
        break;
      }
      case 'reject': {
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
        if (doc.direction !== '發文') return sendJSON(res, 409, { error: '僅「發文」公文可執行發文編號' });
        if (!doc.docNumber) {
          doc.docNumber = nextNumber(docs, '發文');
          appliedNote = appliedNote ? `${appliedNote}（編列發文號 ${doc.docNumber}）` : `編列發文號 ${doc.docNumber}`;
        }
        doc.status = 'dispatched';
        break;
      }
      default:
        doc.status = def.to;
    }

    doc.updatedAt = nowISO();
    doc.history.push({ action: actionKey, label, actor, note: appliedNote, at: nowISO() });
    writeAll(docs);
    recordAudit(req, user, label, doc, appliedNote);

    // 發送站內通知 / Email（排除操作者本人）
    try {
      const others = (arr) => arr.filter((u) => u.id !== user.id);
      const owner = doc.createdBy ? auth.findById(doc.createdBy) : null;
      const ownerArr = owner && owner.id !== user.id ? [owner] : [];
      if (actionKey === 'submit') {
        notifyUsers(others(auth.usersByRole('supervisor')), '有公文待簽核', `${actor} 送核：${doc.subject}`, doc);
      } else if (actionKey === 'sign' || actionKey === 'approve') {
        if (doc.status === 'approved') {
          if (doc.direction === '發文') notifyUsers(others(auth.usersByRole('clerk')), '有公文待發文', `已核定：${doc.subject}`, doc);
          else notifyUsers(ownerArr, '公文已核定', `${doc.subject} 已核定`, doc);
        } else if (doc.status === 'pending') {
          notifyUsers(others(auth.usersByRole('supervisor')), '會簽進行中', `下一關待核章：${doc.subject}`, doc);
        }
      } else if (actionKey === 'reject') {
        notifyUsers(ownerArr, '公文已退回', `${doc.subject} 遭退回${appliedNote ? '：' + appliedNote : ''}`, doc);
      } else if (actionKey === 'dispatch') {
        notifyUsers(ownerArr, '公文已發文', `${doc.subject}（${doc.docNumber}）已發文`, doc);
      } else if (actionKey === 'archive') {
        notifyUsers(ownerArr, '公文已歸檔', `${doc.subject} 已歸檔`, doc);
      }
    } catch (e) {
      console.warn('通知發送失敗：', e.message);
    }

    return sendJSON(res, 200, doc);
  }

  // ---- 單一公文 ----
  if (req.method === 'GET') return sendJSON(res, 200, withDueState(doc, todayStr()));

  if (req.method === 'PUT') {
    if (!canEdit(doc, user)) return sendJSON(res, 403, { error: '僅承辦人或管理員可編輯' });
    if (!['draft', 'returned'].includes(doc.status)) {
      return sendJSON(res, 409, { error: '僅草稿或退回的公文可編輯' });
    }
    const body = await readBody(req);
    const errors = validateDocInput({ ...doc, ...body });
    if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
    const clean = sanitizeDoc(body, doc);
    docs[idx] = { ...doc, ...clean, updatedAt: nowISO() };
    const cur = docs[idx];
    if (clean.direction === '收文' && (!cur.docNumber || !cur.docNumber.startsWith('收-'))) {
      cur.docNumber = nextNumber(docs, '收文');
    } else if (clean.direction === '發文' && cur.docNumber && cur.docNumber.startsWith('收-')) {
      cur.docNumber = null;
    }
    cur.history.push({ action: 'update', label: '修改內容', actor: user.name, note: '', at: nowISO() });
    writeAll(docs);
    recordAudit(req, user, '修改公文', cur, '');
    return sendJSON(res, 200, cur);
  }

  if (req.method === 'DELETE') {
    if (!canEdit(doc, user)) return sendJSON(res, 403, { error: '僅承辦人或管理員可刪除' });
    attachments.removeAll(doc.id);
    docs.splice(idx, 1);
    writeAll(docs);
    recordAudit(req, user, '刪除公文', doc, '');
    return sendJSON(res, 200, { deleted: doc.id });
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

// 啟動伺服器（供 CLI 與 Electron 主程序共用）。
// port 傳 0 可取得系統指派的可用埠；回傳 Promise<{ port, ... }>。
function start(port = PORT, host = HOST) {
  auth.seedUsers();
  templates.seed();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`公文系統已啟動： http://localhost:${addr.port}`);
      resolve(addr);
    });
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('啟動失敗：', err.message);
    process.exit(1);
  });
}

module.exports = { server, start, ACTIONS, STATUS, nextNumber };
