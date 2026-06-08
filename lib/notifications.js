'use strict';

/**
 * 站內系統通知：依使用者投遞，提供未讀數、列表與標示已讀。
 */

const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, readJSON, writeJSON } = require('./db');

const FILE = path.join(DATA_DIR, 'notifications.json');
const MAX = 5000;

const all = () => readJSON(FILE, null) || [];
const save = (list) => writeJSON(FILE, list);

// 對多位使用者建立同一則通知
function add(userIds, { title, body, docId }) {
  const list = all();
  const now = new Date().toISOString();
  (userIds || []).forEach((uid) => {
    list.push({
      id: crypto.randomUUID(),
      userId: uid,
      title: title || '',
      body: body || '',
      docId: docId || null,
      read: false,
      createdAt: now,
    });
  });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  save(list);
}

function forUser(userId, limit = 50) {
  return all().filter((n) => n.userId === userId).slice(-limit).reverse();
}

function unread(userId) {
  return all().filter((n) => n.userId === userId && !n.read).length;
}

// ids 省略則標示該使用者全部為已讀
function markRead(userId, ids) {
  const list = all();
  let count = 0;
  list.forEach((n) => {
    if (n.userId === userId && !n.read && (!ids || ids.includes(n.id))) {
      n.read = true;
      count += 1;
    }
  });
  if (count) save(list);
  return count;
}

module.exports = { add, forUser, unread, markRead };
