'use strict';

/**
 * 使用者、角色權限與工作階段（Session）。
 * 密碼以 scrypt 加鹽雜湊儲存；Session 以記憶體 Map 維護並透過 Cookie 識別。
 */

const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJSON, writeJSON } = require('./db');

const USERS_FILE = path.join(DATA_DIR, 'users.json');

// 角色中文名稱
const ROLES = {
  admin: '系統管理員',
  clerk: '文書',
  supervisor: '主管',
  staff: '承辦人',
};

// 全部權限項目
const ALL_CAPS = [
  'view', 'print', 'create', 'submit',
  'sign', 'approve', 'reject',
  'dispatch', 'archive', 'attach',
  'audit', 'users',
];

// 角色 → 權限
const PERMS = {
  admin: ['*'],
  staff: ['view', 'print', 'create', 'submit', 'attach'],
  supervisor: ['view', 'print', 'sign', 'approve', 'reject'],
  clerk: ['view', 'print', 'create', 'submit', 'attach', 'dispatch', 'archive'],
};

function capsFor(role) {
  const p = PERMS[role] || [];
  return p.includes('*') ? ALL_CAPS.slice() : p.slice();
}

function can(user, cap) {
  if (!user) return false;
  const p = PERMS[user.role] || [];
  return p.includes('*') || p.includes(cap);
}

// ---- 密碼雜湊 ----
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hashPassword(pw, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 使用者儲存 ----
function loadUsers() {
  return readJSON(USERS_FILE, null);
}
function saveUsers(users) {
  writeJSON(USERS_FILE, users);
}

function seedUsers() {
  if (loadUsers()) return;
  const seed = [
    ['admin', 'admin123', '系統管理員', 'admin'],
    ['clerk', 'clerk123', '王文書', 'clerk'],
    ['boss', 'boss123', '李主管', 'supervisor'],
    ['staff', 'staff123', '陳承辦', 'staff'],
  ].map(([username, pw, name, role]) => ({
    id: crypto.randomUUID(),
    username,
    name,
    role,
    password: hashPassword(pw),
    createdAt: new Date().toISOString(),
  }));
  saveUsers(seed);
  console.log('已建立預設帳號（請及早修改密碼）：');
  console.log('  admin/admin123（系統管理員）, clerk/clerk123（文書）');
  console.log('  boss/boss123（主管）, staff/staff123（承辦人）');
}

function findByUsername(username) {
  return (loadUsers() || []).find((u) => u.username === username);
}

function findById(id) {
  return (loadUsers() || []).find((u) => u.id === id);
}

function usernameExists(username, exceptId) {
  return (loadUsers() || []).some((u) => u.username === username && u.id !== exceptId);
}

// 仍可登入的管理員數量（停用者不計），可排除指定使用者以做變更前檢核
function activeAdminCount(exceptId) {
  return (loadUsers() || []).filter(
    (u) => u.role === 'admin' && u.active !== false && u.id !== exceptId
  ).length;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, roleLabel: ROLES[u.role], caps: capsFor(u.role) };
}

// 管理用清單（含狀態，不含密碼雜湊）
function listUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    roleLabel: ROLES[u.role], active: u.active !== false, createdAt: u.createdAt,
  };
}

// ---- Session ----
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小時
const sessions = new Map(); // token -> { user, expires }

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: publicUser(user), expires: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.user;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// 使指定使用者的所有工作階段失效（停用、刪除、變更角色或密碼時）
function destroyUserSessions(userId) {
  for (const [token, s] of sessions) {
    if (s.user && s.user.id === userId) sessions.delete(token);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  return getSession(parseCookies(req).sid);
}

module.exports = {
  ROLES, ALL_CAPS, PERMS, capsFor, can,
  hashPassword, verifyPassword,
  loadUsers, saveUsers, seedUsers, findByUsername, findById,
  usernameExists, activeAdminCount, publicUser, listUser,
  createSession, getSession, destroySession, destroyUserSessions, parseCookies, currentUser,
};
