'use strict';

// ---- 全域狀態 ----
let META = { docTypes: [], priorities: [], classifications: [], statuses: {}, actions: {} };
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- API ----
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `請求失敗 (${res.status})`);
  return data;
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

// ---- 初始化 ----
async function init() {
  META = await api('GET', '/api/meta');
  // 填入下拉選單
  fillSelect($('#f-type'), META.docTypes);
  fillSelect($('#f-priority'), META.priorities);
  fillSelect($('#f-classification'), META.classifications);
  fillSelect($('#filter-type'), META.docTypes, '全部類別');
  const statusEntries = Object.entries(META.statuses);
  const fs = $('#filter-status');
  statusEntries.forEach(([k, v]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = v; fs.appendChild(o);
  });

  $('#btn-new').addEventListener('click', () => openEdit());
  $('#doc-form').addEventListener('submit', onSave);
  $('#search').addEventListener('input', debounce(loadList, 250));
  $('#filter-status').addEventListener('change', loadList);
  $('#filter-type').addEventListener('change', loadList);
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
  const cards = [['total', '公文總數', s.total]];
  const order = ['draft', 'pending', 'approved', 'dispatched', 'archived'];
  order.forEach((k) => cards.push([k, META.statuses[k], s.byStatus[k] || 0]));
  $('#stats').innerHTML = cards
    .map(([, lbl, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="lbl">${esc(lbl)}</div></div>`)
    .join('');
}

// ---- 列表 ----
async function loadList() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  const status = $('#filter-status').value;
  const type = $('#filter-type').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  const docs = await api('GET', '/api/documents?' + params.toString());
  const tbody = $('#doc-list');
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">尚無公文，點選右上角「新增公文」開始建立。</td></tr>';
    return;
  }
  tbody.innerHTML = docs
    .map(
      (d) => `<tr data-id="${d.id}">
        <td>${esc(d.docNumber)}</td>
        <td>${esc(d.type)}</td>
        <td class="subject-cell">${esc(d.subject)}</td>
        <td>${esc(d.recipient || '—')}</td>
        <td class="pri-${esc(d.priority)}">${esc(d.priority)}</td>
        <td>${esc(d.handler || '—')}</td>
        <td><span class="badge st-${d.status}">${esc(META.statuses[d.status])}</span></td>
        <td>${fmtTime(d.updatedAt)}</td>
      </tr>`
    )
    .join('');
  $$('#doc-list tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => openView(tr.dataset.id))
  );
}

// ---- 編輯 / 新增 ----
function openEdit(doc) {
  $('#edit-title').textContent = doc ? '編輯公文' : '新增公文';
  $('#f-id').value = doc ? doc.id : '';
  $('#f-type').value = doc ? doc.type : META.docTypes[0];
  $('#f-priority').value = doc ? doc.priority : META.priorities[0];
  $('#f-classification').value = doc ? doc.classification : META.classifications[0];
  $('#f-subject').value = doc ? doc.subject : '';
  $('#f-sender').value = doc ? doc.sender : '';
  $('#f-recipient').value = doc ? doc.recipient : '';
  $('#f-body').value = doc ? doc.body : '';
  $('#f-handler').value = doc ? doc.handler : '';
  $('#form-error').hidden = true;
  show('#modal-edit');
}

async function onSave(e) {
  e.preventDefault();
  const id = $('#f-id').value;
  const payload = {
    type: $('#f-type').value,
    priority: $('#f-priority').value,
    classification: $('#f-classification').value,
    subject: $('#f-subject').value,
    sender: $('#f-sender').value,
    recipient: $('#f-recipient').value,
    body: $('#f-body').value,
    handler: $('#f-handler').value,
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

// ---- 檢視 / 簽核 ----
async function openView(id) {
  const d = await api('GET', '/api/documents/' + id);
  const meta = [
    ['發文者', d.sender], ['受文者', d.recipient],
    ['速別', d.priority], ['密等', d.classification],
    ['承辦人', d.handler], ['建立時間', fmtTime(d.createdAt)],
  ];
  // 可執行動作
  const avail = Object.entries(META.actions).filter(([, def]) => def.from.includes(d.status));
  const actionButtons = avail
    .map(([key, def]) => `<button class="btn btn-act" data-action="${key}">${esc(def.label)}</button>`)
    .join('');
  const editable = ['draft', 'returned'].includes(d.status);

  $('#view-body').innerHTML = `
    <div class="doc-paper">
      <h3>${esc(d.type)}</h3>
      <div class="docno">${esc(d.docNumber)}　<span class="badge st-${d.status}">${esc(META.statuses[d.status])}</span></div>
      <div class="doc-meta">
        ${meta.map(([k, v]) => `<div><b>${k}</b>${esc(v || '—')}</div>`).join('')}
      </div>
      <div class="doc-subject">主旨：${esc(d.subject)}</div>
      <div class="doc-content">${esc(d.body) || '<span style="color:#9aa">（無本文）</span>'}</div>
    </div>

    <div class="action-bar">
      <input type="text" id="act-actor" placeholder="簽核人姓名" />
      <input type="text" id="act-note" placeholder="批示 / 意見（選填）" />
    </div>
    <div class="action-bar" style="margin-top:10px">
      ${actionButtons || '<span style="color:#9aa;font-size:13px">此公文已完成流程</span>'}
      ${editable ? '<button class="btn" id="v-edit">編輯</button>' : ''}
      <button class="btn btn-danger" id="v-delete">刪除</button>
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

  // 綁定動作
  $$('#view-body [data-action]').forEach((b) =>
    b.addEventListener('click', () => runAction(d.id, b.dataset.action))
  );
  if (editable) $('#v-edit').addEventListener('click', () => { closeModals(); openEdit(d); });
  $('#v-delete').addEventListener('click', () => removeDoc(d.id));

  show('#modal-view');
}

async function runAction(id, action) {
  const actor = $('#act-actor').value.trim();
  const note = $('#act-note').value.trim();
  try {
    await api('POST', `/api/documents/${id}/action`, { action, actor, note });
    toast(`已${META.actions[action].label}`);
    await Promise.all([loadStats(), loadList()]);
    openView(id);
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

// ---- Modal 控制 ----
function show(sel) { $(sel).hidden = false; }
function closeModals() { $$('.modal-backdrop').forEach((m) => (m.hidden = true)); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

init().catch((err) => {
  document.body.innerHTML = `<p style="padding:40px;color:#c0392b">初始化失敗：${esc(err.message)}</p>`;
});
