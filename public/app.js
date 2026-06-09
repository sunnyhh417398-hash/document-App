'use strict';

// ---- 全域狀態 ----
let META = { docTypes: [], priorities: [], classifications: [], directions: [], statuses: {}, actions: {} };
let ME = null; // 目前登入者 { id, name, role, roleLabel, caps }
let TEMPLATES = [];
let LAST_QUERY = '';
let TOKEN = null;
try { TOKEN = localStorage.getItem('docapp_token'); } catch (e) { /* 隱私模式忽略 */ }
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function can(cap) { return !!(ME && ME.caps && ME.caps.includes(cap)); }
function isOwner(doc) { return ME && (ME.role === 'admin' || doc.createdBy === ME.id); }

// ---- API ----
function authHeaders() {
  return TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
}

function setToken(t) {
  TOKEN = t || null;
  try {
    if (TOKEN) localStorage.setItem('docapp_token', TOKEN);
    else localStorage.removeItem('docapp_token');
  } catch (e) { /* 忽略 */ }
}

async function api(method, url, body) {
  const opts = { method, headers: Object.assign({}, authHeaders()) };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `請求失敗 (${res.status})`);
  return data;
}

// 以 token 標頭下載檔案（不依賴 Cookie），存成本機檔案
async function downloadAuthed(url, filename) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    let msg = `下載失敗 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* 忽略 */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
}

// ---- 工具 ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2200);
}
function docNoLabel(d) {
  if (d.docNumber) return d.docNumber;
  return d.direction === '收文' ? '（未編號）' : '（未發文）';
}

// 全文檢索：高亮關鍵字 + 命中主旨外欄位時顯示摘要
function queryTerms() { return (LAST_QUERY || '').split(/\s+/).filter(Boolean); }

function highlight(text) {
  const safe = esc(text);
  const terms = queryTerms();
  if (!terms.length) return safe;
  const pattern = terms
    .map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean).join('|');
  if (!pattern) return safe;
  try { return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>'); }
  catch (e) { return safe; }
}

function subjectCell(d) {
  const terms = queryTerms();
  let html = highlight(d.subject);
  if (terms.length) {
    const subjLow = (d.subject || '').toLowerCase();
    // 摘要來源：本文、會簽意見、處理歷程意見
    const sources = [d.body, ...(d.route || []).map((r) => r.note), ...(d.history || []).map((h) => h.note)].filter(Boolean);
    for (const t of terms) {
      if (subjLow.includes(t.toLowerCase())) continue; // 主旨已含此詞
      for (const src of sources) {
        const i = src.toLowerCase().indexOf(t.toLowerCase());
        if (i >= 0) {
          const start = Math.max(0, i - 12);
          const seg = (start > 0 ? '…' : '') + src.slice(start, i + t.length + 20) + '…';
          html += `<div class="search-snippet">${highlight(seg)}</div>`;
          return html;
        }
      }
    }
  }
  return html;
}

const DUE_LABEL = { overdue: '已逾期', soon: '即將到期' };
function dueMetaLabel(d) {
  if (!d.dueDate) return '';
  const t = DUE_LABEL[d.dueState];
  return t ? `${d.dueDate}（${t}）` : d.dueDate;
}
function dueCell(d) {
  if (!d.dueDate) return '—';
  const tag = d.dueState && DUE_LABEL[d.dueState]
    ? ` <span class="due-tag due-${d.dueState}">${DUE_LABEL[d.dueState]}</span>` : '';
  return `${esc(d.dueDate)}${tag}`;
}

// ---- 初始化 ----
async function init() {
  META = await api('GET', '/api/meta');
  fillSelect($('#f-type'), META.docTypes);
  fillSelect($('#f-priority'), META.priorities);
  fillSelect($('#f-classification'), META.classifications);
  fillSelect($('#f-direction'), META.directions);
  fillSelect($('#filter-type'), META.docTypes, '全部類別');
  fillSelect($('#filter-direction'), META.directions, '收發別');
  const fs = $('#filter-status');
  Object.entries(META.statuses).forEach(([k, v]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = v; fs.appendChild(o);
  });

  // 使用者資訊與權限門禁
  const isAdmin = ME.role === 'admin';
  $('#user-chip').textContent = `${ME.name}（${ME.roleLabel}）`;
  $('#btn-new').hidden = !can('create');
  $('#btn-audit').hidden = !can('audit');
  $('#btn-users').hidden = !can('users');
  $('#btn-templates').hidden = !isAdmin;
  $('#btn-save-template').hidden = !isAdmin;

  $('#btn-new').addEventListener('click', () => openEdit());
  $('#btn-audit').addEventListener('click', openAudit);
  $('#btn-audit-export').addEventListener('click', async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadAuthed('/api/audit/export', `audit-${stamp}.csv`);
    } catch (err) { toast(err.message, true); }
  });
  $('#btn-users').addEventListener('click', openUsers);
  $('#btn-password').addEventListener('click', openPassword);
  $('#password-form').addEventListener('submit', onChangePassword);
  $('#btn-add-user').addEventListener('click', toggleAddUser);
  $('#u-cancel').addEventListener('click', toggleAddUser);
  $('#add-user-form').addEventListener('submit', onCreateUser);
  $('#btn-templates').addEventListener('click', openTemplates);
  $('#btn-save-template').addEventListener('click', saveAsTemplate);
  $('#f-template').addEventListener('change', applyTemplate);
  $('#btn-notif').addEventListener('click', openNotif);
  $('#btn-notif-readall').addEventListener('click', markAllNotifRead);
  // 角色下拉（新增使用者用）
  const ur = $('#u-role');
  Object.entries(META.roles).forEach(([k, v]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = v; ur.appendChild(o);
  });

  await loadTemplates();
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 30000); // 每 30 秒更新未讀數
  $('#doc-form').addEventListener('submit', onSave);
  $('#f-direction').addEventListener('change', toggleIncoming);
  $('#btn-add-stage').addEventListener('click', () => addStageRow());
  $('#search').addEventListener('input', debounce(loadList, 250));
  $('#filter-status').addEventListener('change', loadList);
  $('#filter-type').addEventListener('change', loadList);
  $('#filter-direction').addEventListener('change', loadList);
  $('#filter-due').addEventListener('change', loadList);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $$('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) closeModals(); })
  );

  await Promise.all([loadStats(), loadList()]);
}

function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  if (placeholder) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder; sel.appendChild(o);
  }
  items.forEach((it) => {
    const o = document.createElement('option');
    o.value = it; o.textContent = it; sel.appendChild(o);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- 統計 ----
async function loadStats() {
  const s = await api('GET', '/api/stats');
  const cards = [['total', '公文總數', s.total, '']];
  cards.push(['out', '發文', (s.byDirection && s.byDirection['發文']) || 0, '']);
  cards.push(['in', '收文', (s.byDirection && s.byDirection['收文']) || 0, '']);
  ['pending', 'approved'].forEach((k) =>
    cards.push([k, META.statuses[k], s.byStatus[k] || 0, '']));
  cards.push(['overdue', '已逾期', s.overdue || 0, 'card-overdue']);
  cards.push(['soon', '即將到期', s.soon || 0, 'card-soon']);
  $('#stats').innerHTML = cards
    .map(([key, lbl, num, cls]) =>
      `<div class="stat-card ${cls}" data-due="${key === 'overdue' ? 'overdue' : key === 'soon' ? 'soon' : ''}">
        <div class="num">${num}</div><div class="lbl">${esc(lbl)}</div></div>`)
    .join('');
  // 點擊逾期/即將到期卡片即套用篩選
  $$('#stats .stat-card[data-due="overdue"], #stats .stat-card[data-due="soon"]').forEach((c) =>
    c.addEventListener('click', () => { $('#filter-due').value = c.dataset.due; loadList(); }));
}

// ---- 列表 ----
async function loadList() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) params.set('q', q);
  if ($('#filter-status').value) params.set('status', $('#filter-status').value);
  if ($('#filter-type').value) params.set('type', $('#filter-type').value);
  if ($('#filter-direction').value) params.set('direction', $('#filter-direction').value);
  if ($('#filter-due').value) params.set('due', $('#filter-due').value);
  LAST_QUERY = q;
  const docs = await api('GET', '/api/documents?' + params.toString());
  const tbody = $('#doc-list');
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">尚無公文，點選右上角「新增公文」開始建立。</td></tr>';
    return;
  }
  tbody.innerHTML = docs
    .map((d) => {
      const counterparty = d.direction === '收文' ? d.incomingFrom : d.recipient;
      return `<tr data-id="${d.id}">
        <td>${esc(docNoLabel(d))}</td>
        <td><span class="dir dir-${d.direction === '收文' ? 'in' : 'out'}">${esc(d.direction || '發文')}</span></td>
        <td>${esc(d.type)}</td>
        <td class="subject-cell">${subjectCell(d)}</td>
        <td>${esc(counterparty || '—')}</td>
        <td class="pri-${esc(d.priority)}">${esc(d.priority)}</td>
        <td>${esc(d.handler || '—')}</td>
        <td>${dueCell(d)}</td>
        <td><span class="badge st-${d.status}">${esc(META.statuses[d.status])}</span></td>
        <td>${fmtTime(d.updatedAt)}</td>
      </tr>`;
    })
    .join('');
  $$('#doc-list tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => openView(tr.dataset.id))
  );
}

// ---- 會簽路徑編輯 ----
function addStageRow(stage) {
  const wrap = document.createElement('div');
  wrap.className = 'route-row';
  wrap.innerHTML = `
    <input type="text" class="r-role" placeholder="關卡 / 單位（例：單位主管）" value="${esc(stage ? stage.role : '')}" />
    <input type="text" class="r-assignee" placeholder="會簽人姓名" value="${esc(stage ? stage.assignee : '')}" />
    <button type="button" class="btn btn-sm btn-danger r-del">移除</button>`;
  wrap.querySelector('.r-del').addEventListener('click', () => wrap.remove());
  $('#route-rows').appendChild(wrap);
}

function collectRoute() {
  return $$('#route-rows .route-row')
    .map((row) => ({
      role: row.querySelector('.r-role').value.trim(),
      assignee: row.querySelector('.r-assignee').value.trim(),
    }))
    .filter((s) => s.role || s.assignee);
}

function toggleIncoming() {
  $('#incoming-fields').hidden = $('#f-direction').value !== '收文';
}

// ---- 編輯 / 新增 ----
function openEdit(doc) {
  $('#edit-title').textContent = doc ? '編輯公文' : '新增公文';
  $('#f-template').value = '';
  $('#f-template').parentElement.hidden = !!doc; // 編輯既有公文時不顯示套用範本
  $('#f-id').value = doc ? doc.id : '';
  $('#f-direction').value = doc ? doc.direction : META.directions[0];
  $('#f-type').value = doc ? doc.type : META.docTypes[0];
  $('#f-priority').value = doc ? doc.priority : META.priorities[0];
  $('#f-classification').value = doc ? doc.classification : META.classifications[0];
  $('#f-subject').value = doc ? doc.subject : '';
  $('#f-sender').value = doc ? doc.sender : '';
  $('#f-recipient').value = doc ? doc.recipient : '';
  $('#f-body').value = doc ? doc.body : '';
  $('#f-handler').value = doc ? doc.handler : '';
  $('#f-dueDate').value = doc ? doc.dueDate || '' : '';
  $('#f-incomingFrom').value = doc ? doc.incomingFrom || '' : '';
  $('#f-incomingNumber').value = doc ? doc.incomingNumber || '' : '';
  $('#f-incomingDate').value = doc ? doc.incomingDate || '' : '';
  $('#route-rows').innerHTML = '';
  if (doc && doc.route) doc.route.forEach((s) => addStageRow(s));
  toggleIncoming();
  $('#form-error').hidden = true;
  show('#modal-edit');
}

async function onSave(e) {
  e.preventDefault();
  const id = $('#f-id').value;
  const payload = {
    direction: $('#f-direction').value,
    type: $('#f-type').value,
    priority: $('#f-priority').value,
    classification: $('#f-classification').value,
    subject: $('#f-subject').value,
    sender: $('#f-sender').value,
    recipient: $('#f-recipient').value,
    body: $('#f-body').value,
    handler: $('#f-handler').value,
    dueDate: $('#f-dueDate').value,
    incomingFrom: $('#f-incomingFrom').value,
    incomingNumber: $('#f-incomingNumber').value,
    incomingDate: $('#f-incomingDate').value,
    route: collectRoute(),
  };
  try {
    if (id) await api('PUT', '/api/documents/' + id, payload);
    else await api('POST', '/api/documents', payload);
    closeModals();
    toast(id ? '已更新公文' : '已建立公文');
    await Promise.all([loadStats(), loadList()]);
  } catch (err) {
    const eEl = $('#form-error');
    eEl.textContent = err.message;
    eEl.hidden = false;
  }
}

// ---- 可執行動作（依會簽路徑 / 收發別決定）----
function availableActions(d) {
  const s = d.status;
  const hasRoute = d.route && d.route.length;
  const list = [];
  if (s === 'draft' || s === 'returned') list.push('submit');
  if (s === 'pending') {
    list.push(hasRoute ? 'sign' : 'approve');
    list.push('reject');
  }
  if (s === 'approved') {
    if (d.direction === '發文') list.push('dispatch');
    list.push('archive');
  }
  if (s === 'dispatched') list.push('archive');
  // 僅顯示目前角色有權限的動作
  return list.filter((key) => can(key));
}

function actionLabel(d, key) {
  if (key === 'sign' && d.currentStage != null && d.route[d.currentStage]) {
    const st = d.route[d.currentStage];
    return `核章（第${d.currentStage + 1}關${st.role ? '·' + st.role : ''}）`;
  }
  return META.actions[key].label;
}

// ---- 會簽進度顯示 ----
function renderRoute(d) {
  if (!d.route || !d.route.length) return '';
  const rows = d.route
    .map((s, i) => {
      let badge, cls;
      if (s.decision === 'approve') { badge = '已核章'; cls = 'st-approved'; }
      else if (s.decision === 'reject') { badge = '退回'; cls = 'st-returned'; }
      else if (d.status === 'pending' && i === d.currentStage) { badge = '簽核中'; cls = 'st-pending'; }
      else { badge = '待核'; cls = 'st-draft'; }
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(s.role || '—')}</td>
        <td>${esc(s.assignee || '—')}</td>
        <td><span class="badge ${cls}">${badge}</span></td>
        <td>${esc(s.actor || '')}</td>
        <td>${esc(s.note || '')}</td>
        <td>${fmtTime(s.at)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="route-view">
    <h4>會簽路徑</h4>
    <table class="mini-table">
      <thead><tr><th>關</th><th>單位</th><th>會簽人</th><th>狀態</th><th>核章人</th><th>意見</th><th>時間</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---- 檢視 / 簽核 ----
async function openView(id) {
  const d = await api('GET', '/api/documents/' + id);
  const numLabel = d.direction === '收文' ? '收文字號' : '發文字號';
  const meta = [
    ['收發別', d.direction],
    [numLabel, docNoLabel(d)],
    ['發文者', d.sender],
    ['受文者', d.recipient],
    ['速別', d.priority],
    ['密等', d.classification],
    ['承辦人', d.handler],
    ['限辦日期', dueMetaLabel(d)],
    ['建立時間', fmtTime(d.createdAt)],
  ];
  if (d.direction === '收文') {
    meta.push(['來文機關', d.incomingFrom], ['來文字號', d.incomingNumber], ['來文日期', d.incomingDate]);
  }

  const actions = availableActions(d);
  const actionButtons = actions
    .map((key) => `<button class="btn btn-act" data-action="${key}">${esc(actionLabel(d, key))}</button>`)
    .join('');
  const editable = ['draft', 'returned'].includes(d.status) && isOwner(d);
  const showSign = actions.length > 0;

  $('#view-body').innerHTML = `
    <div class="doc-paper">
      <h3>${esc(d.type)}</h3>
      <div class="docno">${esc(docNoLabel(d))}　<span class="badge st-${d.status}">${esc(META.statuses[d.status])}</span></div>
      <div class="doc-meta">
        ${meta.map(([k, v]) => `<div><b>${k}</b>${esc(v || '—')}</div>`).join('')}
      </div>
      <div class="doc-subject">主旨：${esc(d.subject)}</div>
      <div class="doc-content">${esc(d.body) || '<span style="color:#9aa">（無本文）</span>'}</div>
    </div>

    ${renderRoute(d)}

    ${renderAttachments(d)}

    ${showSign ? `<div class="action-bar">
      <input type="text" id="act-actor" placeholder="簽核人姓名（預設為您）" />
      <input type="text" id="act-note" placeholder="批示 / 意見（選填）" />
    </div>` : ''}
    <div class="action-bar" style="margin-top:10px">
      ${actionButtons || '<span style="color:#9aa;font-size:13px">目前無可執行的簽核動作</span>'}
      <span class="spacer"></span>
      <button class="btn" id="v-print">🖨️ 列印套表</button>
      <button class="btn" id="v-pdf">📄 匯出 PDF</button>
      ${editable ? '<button class="btn" id="v-edit">編輯</button>' : ''}
      ${isOwner(d) ? '<button class="btn btn-danger" id="v-delete">刪除</button>' : ''}
    </div>

    <div class="history">
      <h4>處理歷程</h4>
      <ul class="timeline">
        ${[...d.history].reverse().map((h) => `
          <li>
            <span class="t-action">${esc(h.label)}</span>
            <span style="color:#444">${esc(h.actor || '')}</span>
            <span class="t-time">${fmtTime(h.at)}</span>
            ${h.note ? `<span class="t-note">批示：${esc(h.note)}</span>` : ''}
          </li>`).join('')}
      </ul>
    </div>`;

  $$('#view-body [data-action]').forEach((b) =>
    b.addEventListener('click', () => runAction(d.id, b.dataset.action))
  );
  if (editable) $('#v-edit').addEventListener('click', () => { closeModals(); openEdit(d); });
  const delBtn = $('#v-delete');
  if (delBtn) delBtn.addEventListener('click', () => removeDoc(d.id));
  $('#v-print').addEventListener('click', () => printDoc(d, false));
  $('#v-pdf').addEventListener('click', () => printDoc(d, true));
  bindAttachments(d);

  show('#modal-view');
}

// ---- 附件 ----
function renderAttachments(d) {
  const list = (d.attachments || [])
    .map((a) => `<li>
      <a href="#" class="att-dl" data-att="${a.id}" data-fn="${esc(a.filename)}">📎 ${esc(a.filename)}</a>
      <span class="att-meta">${fmtKB(a.size)} · ${esc(a.uploadedBy)} · ${fmtTime(a.uploadedAt)}</span>
      ${isOwner(d) ? `<button class="att-del" data-att="${a.id}">移除</button>` : ''}
    </li>`)
    .join('');
  const canUpload = can('attach') && d.status !== 'archived';
  return `<div class="attach-view">
    <h4>附件（${(d.attachments || []).length}）</h4>
    <ul class="attach-list">${list || '<li class="att-empty">尚無附件</li>'}</ul>
    ${canUpload ? `<div class="attach-upload">
      <input type="file" id="att-file" />
      <button class="btn btn-sm btn-act" id="att-upload">上傳附件</button>
      <span class="hint">單檔上限 10MB</span>
    </div>` : ''}
  </div>`;
}

function fmtKB(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function bindAttachments(d) {
  $$('#view-body .att-dl').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await downloadAuthed(`/api/documents/${d.id}/attachments/${a.dataset.att}`, a.dataset.fn); }
      catch (err) { toast(err.message, true); }
    })
  );
  $$('#view-body .att-del').forEach((b) =>
    b.addEventListener('click', () => deleteAttachment(d.id, b.dataset.att))
  );
  const up = $('#att-upload');
  if (up) up.addEventListener('click', () => uploadAttachment(d.id));
}

function uploadAttachment(id) {
  const input = $('#att-file');
  const file = input.files[0];
  if (!file) { toast('請先選擇檔案', true); return; }
  if (file.size > 10 * 1024 * 1024) { toast('附件超過 10MB 上限', true); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('POST', `/api/documents/${id}/attachments`, { filename: file.name, data: reader.result });
      toast('附件已上傳');
      openView(id);
    } catch (err) {
      toast(err.message, true);
    }
  };
  reader.onerror = () => toast('讀取檔案失敗', true);
  reader.readAsDataURL(file);
}

async function deleteAttachment(id, attId) {
  if (!confirm('確定要移除這個附件嗎？')) return;
  try {
    await api('DELETE', `/api/documents/${id}/attachments/${attId}`);
    toast('已移除附件');
    openView(id);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 稽核軌跡 ----
async function openAudit() {
  try {
    const rows = await api('GET', '/api/audit?limit=300');
    $('#audit-rows').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtTime(r.at)}</td>
          <td>${esc(r.actor)}</td>
          <td>${esc(r.role)}</td>
          <td>${esc(r.action)}</td>
          <td>${esc([r.docNumber, r.subject].filter(Boolean).join(' '))}</td>
          <td>${esc(r.detail)}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">尚無紀錄</td></tr>';
    show('#modal-audit');
  } catch (err) {
    toast(err.message, true);
  }
}

async function runAction(id, action) {
  const actorEl = $('#act-actor');
  const noteEl = $('#act-note');
  const actor = actorEl ? actorEl.value.trim() : '';
  const note = noteEl ? noteEl.value.trim() : '';
  try {
    const updated = await api('POST', `/api/documents/${id}/action`, { action, actor, note });
    toast(`已${META.actions[action].label}`);
    await Promise.all([loadStats(), loadList()]);
    refreshNotifBadge();
    openView(id);
    // 發文後若剛編號，提示文號
    if (action === 'dispatch' && updated.docNumber) toast(`發文字號：${updated.docNumber}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeDoc(id) {
  if (!confirm('確定要刪除這份公文嗎？此動作無法復原。')) return;
  try {
    await api('DELETE', '/api/documents/' + id);
    closeModals();
    toast('已刪除公文');
    await Promise.all([loadStats(), loadList()]);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 列印套表 / 匯出 PDF（標準公文紙格式）----
function buildPrintHTML(d) {
  const numLabel = d.direction === '收文' ? '收文字號' : '發文字號';
  const rows = [
    ['受文者', d.recipient],
    ['發文者', d.sender],
    ['速別', d.priority],
    ['密等', d.classification],
    [numLabel, docNoLabel(d)],
    ['發文日期', fmtDate(d.updatedAt)],
    ['限辦日期', d.dueDate || ''],
  ];
  if (d.direction === '收文') {
    rows.push(['來文機關', d.incomingFrom], ['來文字號', d.incomingNumber], ['來文日期', d.incomingDate]);
  }
  const metaRows = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`)
    .join('');

  const signTable = (d.route && d.route.length)
    ? `<table class="sign-tbl"><thead><tr>
         ${d.route.map((s) => `<th>${esc(s.role || '會簽')}</th>`).join('')}
       </tr></thead><tbody><tr>
         ${d.route.map((s) => `<td>${s.decision === 'approve' ? '✔ ' + esc(s.actor || '') : (s.decision === 'reject' ? '✘ 退回' : '')}<br><small>${fmtDate(s.at)}</small></td>`).join('')}
       </tr></tbody></table>`
    : `<table class="sign-tbl"><thead><tr><th>承辦</th><th>會核</th><th>決行</th></tr></thead>
       <tbody><tr><td>${esc(d.handler || '')}</td><td></td><td></td></tr></tbody></table>`;

  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
<title>${esc(docNoLabel(d))}_${esc(d.subject)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: "Noto Sans TC","Microsoft JhengHei",sans-serif; color:#000; line-height:1.9; }
  .head { text-align:center; }
  .head .org { font-size:15px; letter-spacing:2px; }
  .head .title { font-size:26px; font-weight:700; letter-spacing:12px; margin:6px 0; }
  .meta { width:100%; border-collapse:collapse; margin:14px 0; }
  .meta th { width:90px; text-align:left; vertical-align:top; color:#333; font-weight:600; padding:3px 8px 3px 0; white-space:nowrap; }
  .meta td { padding:3px 0; }
  .subject { font-size:17px; font-weight:700; margin:16px 0 8px; }
  .content { white-space:pre-wrap; font-size:15px; min-height:120px; }
  .label { font-weight:700; }
  .sign-wrap { margin-top:30px; }
  .sign-wrap h4 { margin:0 0 6px; font-size:13px; color:#333; }
  .sign-tbl { width:100%; border-collapse:collapse; text-align:center; }
  .sign-tbl th, .sign-tbl td { border:1px solid #000; padding:8px 4px; font-size:13px; height:54px; vertical-align:top; }
  .foot { margin-top:18px; font-size:13px; }
  hr { border:none; border-top:1px solid #000; }
  @media screen { body { max-width:780px; margin:24px auto; padding:0 16px; } }
</style></head>
<body onload="window.print()">
  <div class="head">
    <div class="org">${esc(d.sender || '　')}</div>
    <div class="title">${esc(d.type)}</div>
  </div>
  <hr>
  <table class="meta">${metaRows}</table>
  <div class="subject">主旨：${esc(d.subject)}</div>
  <div class="content"><span class="label">說明：</span>\n${esc(d.body) || '（無）'}</div>
  <div class="foot">正本：${esc(d.recipient || '　')}</div>
  <div class="sign-wrap">
    <h4>會簽 / 決行</h4>
    ${signTable}
  </div>
</body></html>`;
}

function printDoc(d, asPdf) {
  const w = window.open('', '_blank');
  if (!w) {
    toast('請允許彈出視窗以列印 / 匯出 PDF', true);
    return;
  }
  w.document.open();
  w.document.write(buildPrintHTML(d));
  w.document.close();
  if (asPdf) toast('於列印視窗選擇「另存為 PDF」即可匯出');
}

// ---- 使用者管理 ----
function toggleAddUser() {
  const f = $('#add-user-form');
  f.hidden = !f.hidden;
  if (!f.hidden) {
    $('#u-username').value = '';
    $('#u-name').value = '';
    $('#u-email').value = '';
    $('#u-password').value = '';
    $('#user-form-error').hidden = true;
    $('#u-username').focus();
  }
}

async function openUsers() {
  await loadUsers();
  $('#add-user-form').hidden = true;
  show('#modal-users');
}

async function loadUsers() {
  const users = await api('GET', '/api/users');
  const roleOpts = (sel) => Object.entries(META.roles)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('#users-rows').innerHTML = users.map((u) => {
    const self = u.id === ME.id;
    return `<tr class="${u.active ? '' : 'row-inactive'}">
      <td>${esc(u.name)}${self ? ' <span class="self-tag">（您）</span>' : ''}</td>
      <td>${esc(u.username)}</td>
      <td><input type="email" class="u-email" data-id="${u.id}" value="${esc(u.email || '')}" placeholder="—" /></td>
      <td><select class="u-role-sel" data-id="${u.id}" ${self ? 'disabled' : ''}>${roleOpts(u.role)}</select></td>
      <td><span class="badge ${u.active ? 'st-approved' : 'st-returned'}">${u.active ? '啟用' : '停用'}</span></td>
      <td class="user-ops">
        <button class="btn btn-sm" data-act="toggle" data-id="${u.id}" ${self ? 'disabled' : ''}>${u.active ? '停用' : '啟用'}</button>
        <button class="btn btn-sm" data-act="pw" data-id="${u.id}">重設密碼</button>
        <button class="btn btn-sm btn-danger" data-act="del" data-id="${u.id}" ${self ? 'disabled' : ''}>刪除</button>
      </td>
    </tr>`;
  }).join('');

  $$('#users-rows .u-role-sel').forEach((s) =>
    s.addEventListener('change', () => updateUser(s.dataset.id, { role: s.value })));
  $$('#users-rows .u-email').forEach((inp) =>
    inp.addEventListener('change', () => updateUser(inp.dataset.id, { email: inp.value.trim() })));
  $$('#users-rows [data-act]').forEach((b) =>
    b.addEventListener('click', () => userOp(b.dataset.act, b.dataset.id)));
}

async function userOp(act, id) {
  const row = $$('#users-rows tr').find((tr) => tr.querySelector(`[data-id="${id}"]`));
  const active = row && row.querySelector('.badge').textContent === '啟用';
  if (act === 'toggle') return updateUser(id, { active: !active });
  if (act === 'del') {
    if (!confirm('確定要刪除這個帳號嗎？此動作無法復原。')) return;
    try { await api('DELETE', '/api/users/' + id); toast('已刪除使用者'); loadUsers(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (act === 'pw') {
    const pw = prompt('請輸入新密碼（至少 6 碼）：');
    if (!pw) return;
    try { await api('POST', `/api/users/${id}/password`, { password: pw }); toast('已重設密碼'); }
    catch (err) { toast(err.message, true); }
  }
}

async function updateUser(id, fields) {
  try { await api('PUT', '/api/users/' + id, fields); toast('已更新使用者'); loadUsers(); }
  catch (err) { toast(err.message, true); loadUsers(); }
}

async function onCreateUser(e) {
  e.preventDefault();
  const errEl = $('#user-form-error');
  errEl.hidden = true;
  try {
    await api('POST', '/api/users', {
      username: $('#u-username').value.trim(),
      name: $('#u-name').value.trim(),
      email: $('#u-email').value.trim(),
      role: $('#u-role').value,
      password: $('#u-password').value,
    });
    toast('已新增使用者');
    $('#add-user-form').hidden = true;
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

// ---- 修改自己密碼 ----
function openPassword() {
  $('#p-current').value = '';
  $('#p-new').value = '';
  $('#p-confirm').value = '';
  $('#password-error').hidden = true;
  show('#modal-password');
}

async function onChangePassword(e) {
  e.preventDefault();
  const errEl = $('#password-error');
  errEl.hidden = true;
  if ($('#p-new').value !== $('#p-confirm').value) {
    errEl.textContent = '兩次輸入的新密碼不一致';
    errEl.hidden = false;
    return;
  }
  try {
    await api('POST', '/api/me/password', {
      currentPassword: $('#p-current').value,
      newPassword: $('#p-new').value,
    });
    closeModals();
    toast('密碼已更新');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

// ---- 公文範本 ----
async function loadTemplates() {
  TEMPLATES = await api('GET', '/api/templates');
  const sel = $('#f-template');
  sel.innerHTML = '<option value="">（不套用範本）</option>' +
    TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
}

function applyTemplate() {
  const t = TEMPLATES.find((x) => x.id === $('#f-template').value);
  if (!t) return;
  $('#f-direction').value = t.direction;
  toggleIncoming();
  $('#f-type').value = t.type;
  $('#f-priority').value = t.priority;
  $('#f-classification').value = t.classification;
  if (t.subjectTpl) $('#f-subject').value = t.subjectTpl;
  if (t.bodyTpl) $('#f-body').value = t.bodyTpl;
  $('#route-rows').innerHTML = '';
  (t.route || []).forEach((s) => addStageRow(s));
  toast(`已套用範本：${t.name}`);
}

async function saveAsTemplate() {
  const name = prompt('請輸入範本名稱：');
  if (!name) return;
  try {
    await api('POST', '/api/templates', {
      name,
      direction: $('#f-direction').value,
      type: $('#f-type').value,
      priority: $('#f-priority').value,
      classification: $('#f-classification').value,
      subjectTpl: $('#f-subject').value,
      bodyTpl: $('#f-body').value,
      route: collectRoute(),
    });
    await loadTemplates();
    toast('已另存為範本');
  } catch (err) {
    toast(err.message, true);
  }
}

async function openTemplates() {
  await loadTemplates();
  renderTemplates();
  show('#modal-templates');
}

function renderTemplates() {
  $('#templates-rows').innerHTML = TEMPLATES.length
    ? TEMPLATES.map((t) => `<tr>
        <td>${esc(t.name)}</td>
        <td>${esc(t.type)}</td>
        <td>${esc(t.direction)}</td>
        <td>${esc(t.subjectTpl || '—')}</td>
        <td>${(t.route || []).length} 關</td>
        <td><button class="btn btn-sm btn-danger" data-tpl="${t.id}">刪除</button></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">尚無範本</td></tr>';
  $$('#templates-rows [data-tpl]').forEach((b) =>
    b.addEventListener('click', () => deleteTemplate(b.dataset.tpl)));
}

async function deleteTemplate(id) {
  if (!confirm('確定要刪除這個範本嗎？')) return;
  try {
    await api('DELETE', '/api/templates/' + id);
    await loadTemplates();
    renderTemplates();
    toast('已刪除範本');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 站內通知 ----
async function refreshNotifBadge() {
  try {
    const data = await api('GET', '/api/notifications');
    const badge = $('#notif-badge');
    if (data.unread > 0) {
      badge.textContent = data.unread > 99 ? '99+' : data.unread;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
    return data;
  } catch (err) { /* 未登入或網路問題，忽略 */ }
}

async function openNotif() {
  const data = await refreshNotifBadge();
  const items = (data && data.items) || [];
  $('#notif-list').innerHTML = items.length
    ? items.map((n) => `<li class="${n.read ? '' : 'unread'}" ${n.docId ? `data-doc="${n.docId}"` : ''} data-id="${n.id}">
        <div class="notif-title">${esc(n.title)}</div>
        <div class="notif-body">${esc(n.body)}</div>
        <div class="notif-time">${fmtTime(n.createdAt)}</div>
      </li>`).join('')
    : '<li class="empty">目前沒有通知</li>';
  $$('#notif-list li[data-doc]').forEach((li) =>
    li.addEventListener('click', async () => {
      await api('POST', '/api/notifications/read', { ids: [li.dataset.id] }).catch(() => {});
      closeModals();
      refreshNotifBadge();
      openView(li.dataset.doc);
    }));
  show('#modal-notif');
}

async function markAllNotifRead() {
  try {
    await api('POST', '/api/notifications/read', {});
    openNotif();
  } catch (err) { toast(err.message, true); }
}

// ---- Modal 控制 ----
function show(sel) { $(sel).hidden = false; }
function closeModals() { $$('.modal-backdrop').forEach((m) => (m.hidden = true)); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// ---- 身分驗證 / 啟動 ----
function showLogin() {
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}
function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
}

async function onLogin(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const errEl = $('#login-error');
  errEl.hidden = true;
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  if (!username || !password) {
    errEl.textContent = '請輸入帳號與密碼';
    errEl.hidden = false;
    return;
  }
  let data;
  try {
    data = await api('POST', '/api/login', { username, password });
  } catch (err) {
    // 帳號/密碼或連線錯誤
    errEl.textContent = err.message;
    errEl.hidden = false;
    return;
  }
  // 驗證成功，改用 token 標頭維持登入
  setToken(data.token);
  ME = data;
  $('#login-password').value = '';
  try {
    showApp();
    await init();
  } catch (err) {
    // 登入成功但載入失敗：退回登入畫面並顯示真正的錯誤，方便診斷
    showLogin();
    errEl.textContent = '登入後載入失敗：' + err.message;
    errEl.hidden = false;
  }
}

async function onLogout() {
  try { await api('POST', '/api/logout'); } catch (e) { /* 忽略 */ }
  ME = null;
  setToken(null);
  location.reload();
}

// 全域錯誤攔截：打包版沒有可見的主控台，將未捕捉的錯誤顯示於畫面上方
function showFatal(msg) {
  let bar = document.getElementById('fatal-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;padding:10px 16px;font-size:13px;font-family:sans-serif;white-space:pre-wrap;';
    document.body.appendChild(bar);
  }
  bar.textContent = '發生錯誤：' + msg + '（可按 Ctrl+Shift+I 開啟主控台查看細節）';
}
window.addEventListener('error', (ev) => showFatal(ev.message || String(ev.error || '')));
window.addEventListener('unhandledrejection', (ev) =>
  showFatal((ev.reason && (ev.reason.message || ev.reason)) || '未處理的錯誤'));

async function boot() {
  try {
    // 同時綁定按鈕點擊與表單送出（Enter），避免任一失效時無法登入
    const btn = $('#login-btn');
    if (btn) btn.addEventListener('click', onLogin);
    const form = $('#login-form');
    if (form) form.addEventListener('submit', onLogin);
    $('#btn-logout').addEventListener('click', onLogout);
  } catch (err) {
    showFatal('初始化登入畫面失敗：' + err.message);
    return;
  }
  try {
    ME = await api('GET', '/api/me'); // 有有效 token 才會成功
    showApp();
    await init();
  } catch (err) {
    showLogin(); // 未登入屬正常情況
  }
}

boot();
