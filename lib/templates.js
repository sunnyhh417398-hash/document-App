'use strict';

/**
 * 公文範本：提供常用公文的預填內容（類別、主旨、本文、會簽路徑等）。
 */

const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, readJSON, writeJSON } = require('./db');

const FILE = path.join(DATA_DIR, 'templates.json');

const all = () => readJSON(FILE, null) || [];
const save = (list) => writeJSON(FILE, list);

function seed() {
  if (readJSON(FILE, null)) return;
  const now = new Date().toISOString();
  const t = (o) => Object.assign({ id: crypto.randomUUID(), createdAt: now }, o);
  save([
    t({
      name: '一般函稿', direction: '發文', type: '函', priority: '普通件', classification: '普通',
      subjectTpl: '函送○○○相關資料，請查照。',
      bodyTpl: '一、依據○○○辦理。\n二、檢附○○○乙份，請查照。',
      route: [{ role: '單位主管', assignee: '' }, { role: '機關首長', assignee: '' }],
    }),
    t({
      name: '開會通知單', direction: '發文', type: '開會通知單', priority: '速件', classification: '普通',
      subjectTpl: '檢送「○○○會議」開會通知單，請查照並準時出席。',
      bodyTpl: '開會事由：○○○\n開會時間：○年○月○日（星期○）上午○時○分\n開會地點：○○○\n主持人：○○○\n聯絡人及電話：○○○',
      route: [{ role: '單位主管', assignee: '' }],
    }),
    t({
      name: '簽呈', direction: '發文', type: '簽', priority: '普通件', classification: '普通',
      subjectTpl: '為○○○一案，簽請核示。',
      bodyTpl: '一、說明：○○○。\n二、擬辦：○○○。\n敬陳\n　　　長官核示。',
      route: [{ role: '單位主管', assignee: '' }, { role: '機關首長', assignee: '' }],
    }),
  ]);
}

module.exports = { all, save, seed, FILE };
