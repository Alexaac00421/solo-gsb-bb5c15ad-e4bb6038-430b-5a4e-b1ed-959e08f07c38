'use strict';
/* ================= utilities ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const TYPE_LABEL = { light: '灯光', sound: '音效', scene: '换景' };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtClock(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtTime(isoOrSqlite) {
  if (!isoOrSqlite) return '';
  const d = new Date(isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return isoOrSqlite;
  return d.toLocaleString('zh-CN', { hour12: false });
}
function genRequestNo() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `REQ-${ts}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.reason || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(title, msg, kind = 'ok', ms = 4500) {
  const el = $('#toast');
  el.className = `toast ${kind === 'bad' ? 'bad' : kind === 'warn' ? 'warnbox' : 'ok'}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div><div>${esc(msg || '')}</div>`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function illegal(msg) { toast('⛔ 非法操作，已拒绝', msg, 'bad', 7000); }

/* ================= tabs ================= */
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
  if (t.dataset.tab === 'versions') loadVersionsTab();
  if (t.dataset.tab === 'console') refreshPerfList();
  if (t.dataset.tab === 'logs') loadLogs();
}));

/* ================= editor ================= */
const Ed = { showId: null, cues: [] };

async function loadShowSelect() {
  const { shows } = await api('GET', '/api/shows');
  for (const [sel, keep] of [[$('#ed-show-select'), Ed.showId], [$('#v-show-select'), null]]) {
    sel.innerHTML = shows.map((s) =>
      `<option value="${s.id}"${String(s.id) === String(keep) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  return shows;
}

async function loadEditorShow(id) {
  const data = await api('GET', `/api/shows/${id}`);
  Ed.showId = id;
  Ed.cues = data.cues.map((c) => ({ ...c }));
  $('#ed-meta').textContent =
    `最近保存：${fmtTime(data.show.updated_at)} · 已发布版本：${data.versions.length} 个（草稿改动不影响已发布版本）`;
  renderEditorRows();
}

function recalcPlanned() {
  let acc = 0;
  Ed.cues.forEach((c) => { acc += Number(c.waitSecs) || 0; c.plannedSecs = acc; });
  $('#ed-total').textContent = Ed.cues.length
    ? `共 ${Ed.cues.length} 条 · 预计总时长 ${fmtClock(acc)}（${acc} 秒）` : '（空草稿）';
}

function renderEditorRows() {
  const tb = $('#ed-rows');
  tb.innerHTML = Ed.cues.map((c, i) => `
    <tr data-i="${i}">
      <td><div class="rowbtns">
        <button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn" data-act="down" ${i === Ed.cues.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn" data-act="del">删</button>
      </div></td>
      <td class="seqcell">${i + 1}</td>
      <td><select data-f="cueType">
        ${Object.entries(TYPE_LABEL).map(([k, v]) =>
          `<option value="${k}"${c.cueType === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select></td>
      <td><input type="text" data-f="title" value="${esc(c.title)}" placeholder="如：开场面光" /></td>
      <td><input type="number" min="0" step="1" data-f="waitSecs" value="${c.waitSecs}" /></td>
      <td><input type="text" data-f="instruction" value="${esc(c.instruction)}" placeholder="操作说明" /></td>
      <td class="planned">${fmtClock(c.plannedSecs || 0)}</td>
    </tr>`).join('');
  recalcPlanned();
}

function readEditorRows() {
  const cues = [];
  $$('#ed-rows tr').forEach((tr) => {
    cues.push({
      cueType: tr.querySelector('[data-f=cueType]').value,
      title: tr.querySelector('[data-f=title]').value.trim(),
      waitSecs: tr.querySelector('[data-f=waitSecs]').value,
      instruction: tr.querySelector('[data-f=instruction]').value.trim(),
    });
  });
  return cues;
}

$('#ed-show-select').addEventListener('change', (e) => loadEditorShow(e.target.value));
$('#ed-new-show').addEventListener('click', async () => {
  const name = prompt('新场次名称：');
  if (!name) return;
  const created = await api('POST', '/api/shows', { name });
  await loadShowSelect();
  $('#ed-show-select').value = created.id;
  await loadEditorShow(created.id);
  toast('场次已创建', name);
});

$('#ed-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.closest('tr').dataset.i);
  const cues = readEditorRows();
  if (btn.dataset.act === 'up' && i > 0) [cues[i - 1], cues[i]] = [cues[i], cues[i - 1]];
  if (btn.dataset.act === 'down' && i < cues.length - 1) [cues[i + 1], cues[i]] = [cues[i], cues[i + 1]];
  if (btn.dataset.act === 'del') cues.splice(i, 1);
  Ed.cues = cues;
  renderEditorRows();
});

// Live re-planned time preview while editing (non-negative only in preview)
$('#ed-rows').addEventListener('input', () => {
  const cues = readEditorRows();
  let acc = 0;
  cues.forEach((c, i) => {
    const w = Number(c.waitSecs);
    if (Number.isInteger(w) && w >= 0) { acc += w; Ed.cues[i].plannedSecs = acc; }
    const cell = $$('#ed-rows tr')[i]?.querySelector('.planned');
    if (cell) cell.textContent = Number.isInteger(w) && w >= 0 ? fmtClock(acc) : '非法';
  });
});

$('#ed-add').addEventListener('click', () => {
  Ed.cues = readEditorRows();
  Ed.cues.push({ cueType: 'light', title: '', waitSecs: 0, instruction: '' });
  renderEditorRows();
  const rows = $$('#ed-rows tr');
  rows[rows.length - 1].querySelector('[data-f=title]').focus();
});

$('#ed-save').addEventListener('click', async () => {
  try {
    const data = await api('PUT', `/api/shows/${Ed.showId}/cues`, { cues: readEditorRows() });
    Ed.cues = data.cues;
    renderEditorRows();
    toast('草稿已保存', `已保存 ${data.cues.length} 条提示并重新计算预计时间；已发布版本不受影响。`);
  } catch (err) {
    illegal(`${err.message}（本次保存未写入任何内容）`);
  }
});

$('#ed-publish').addEventListener('click', async () => {
  // Save first so the published snapshot equals what's on screen.
  let cues;
  try {
    const data = await api('PUT', `/api/shows/${Ed.showId}/cues`, { cues: readEditorRows() });
    cues = data.cues;
  } catch (err) {
    illegal(`草稿保存失败，未发布：${err.message}`);
    return;
  }
  const label = prompt(`将把当前草稿（${cues.length} 条）发布为不可变版本。版本标签（可留空）：`, '');
  if (label === null) return;
  const createdBy = $('#c-operator')?.value || '舞台监督';
  try {
    const v = await api('POST', `/api/shows/${Ed.showId}/publish`, { label, createdBy });
    toast('版本已发布', `v${v.versionNo} · 总时长 ${fmtClock(v.totalSecs)}。此后草稿修改不会影响该版本。`);
    loadEditorShow(Ed.showId);
  } catch (err) { illegal(err.message); }
});

/* ================= versions ================= */
let selectedVersion = null;

async function loadVersionsTab() {
  const shows = await loadShowSelect();
  const sid = $('#v-show-select').value || shows[0]?.id;
  if (sid) $('#v-show-select').value = sid;
  const { versions } = await api('GET', `/api/shows/${sid}/versions`);
  const el = $('#v-list');
  if (!versions.length) {
    el.innerHTML = '<div class="empty-note">该场次还没有发布版本。请先到「场记编排」保存草稿并发布。</div>';
    $('#v-detail').innerHTML = '';
    return;
  }
  el.innerHTML = versions.map((v) => `
    <div class="card ${selectedVersion === v.id ? 'selected' : ''}" data-vid="${v.id}">
      <h3><span class="vno">v${v.version_no}</span> ${esc(v.label || '（无标签）')}</h3>
      <div class="line">发布于 ${fmtTime(v.created_at)} · 发布人 ${esc(v.created_by)}</div>
      <div class="line">${v.item_count ?? '?'} 条提示 · 总时长 ${fmtClock(v.total_secs)}（不可变）</div>
    </div>`).join('');
  if (!selectedVersion || !versions.some((v) => v.id === selectedVersion)) {
    selectedVersion = versions[0].id;
    loadVersionDetail(selectedVersion);
  }
}

$('#v-show-select').addEventListener('change', () => { selectedVersion = null; loadVersionsTab(); });
$('#v-refresh').addEventListener('click', loadVersionsTab);
$('#v-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  selectedVersion = Number(card.dataset.vid);
  loadVersionDetail(selectedVersion);
  $$('#v-list .card').forEach((c) => c.classList.toggle('selected', Number(c.dataset.vid) === selectedVersion));
});

async function loadVersionDetail(vid) {
  const { version, items } = await api('GET', `/api/versions/${vid}`);
  $('#v-detail').innerHTML = `
    <h3 style="margin-top:0">${esc(version.show_name)} — v${version.version_no}（${esc(version.label || '无标签')}）
      <span class="meta">发布于 ${fmtTime(version.created_at)}</span></h3>
    <table class="cue-table"><thead><tr>
      <th style="width:60px">顺序</th><th style="width:80px">类型</th><th>提示标题</th>
      <th style="width:100px">相对等待</th><th style="width:100px">预计时间</th><th>操作说明</th>
    </tr></thead><tbody>
    ${items.map((c) => `<tr>
      <td class="seqcell">${c.seq}</td>
      <td><span class="typ typ-${c.cueType}">${TYPE_LABEL[c.cueType]}</span></td>
      <td><b>${esc(c.title)}</b></td>
      <td>${c.waitSecs} 秒</td>
      <td>${fmtClock(c.plannedSecs)}</td>
      <td>${esc(c.instruction)}</td>
    </tr>`).join('')}
    </tbody></table>`;
}

/* ================= console ================= */
const C = { perfId: null, state: null, poll: null, lastAction: 0 };

async function refreshPerfList() {
  const { performances } = await api('GET', '/api/performances');
  const opts = performances.length
    ? performances.map((p) => `<option value="${p.id}">演出#${p.id} · ${esc(p.show_name)} v${p.version_no} · ${p.status === 'running' ? '进行中' : '已结束'} · ${esc(p.operator)}</option>`).join('')
    : '<option value="">（暂无演出）</option>';
  $('#c-perf-select').innerHTML = opts;
  $('#l-perf-select').innerHTML = '<option value="">全部演出</option>' +
    performances.map((p) => `<option value="${p.id}">#${p.id} ${esc(p.show_name)} v${p.version_no}</option>`).join('');
  if (C.perfId && performances.some((p) => p.id === C.perfId)) $('#c-perf-select').value = C.perfId;
  return performances;
}

async function loadAllVersionsForLaunch() {
  const { shows } = await api('GET', '/api/shows');
  const groups = [];
  for (const s of shows) {
    const { versions } = await api('GET', `/api/shows/${s.id}/versions`);
    for (const v of versions) groups.push({ s, v });
  }
  $('#c-version-select').innerHTML = groups.length
    ? groups.map((g) => `<option value="${g.v.id}">${esc(g.s.name)} — v${g.v.version_no} ${esc(g.v.label || '')}</option>`).join('')
    : '<option value="">（没有已发布版本，请先编排并发布）</option>';
  return groups.length;
}

$('#c-new').addEventListener('click', async () => {
  $('#c-launch').classList.toggle('hidden');
  await loadAllVersionsForLaunch();
});

$('#c-start').addEventListener('click', async () => {
  const versionId = Number($('#c-version-select').value);
  const operator = $('#c-operator').value.trim() || '操作员';
  if (!versionId) { illegal('没有可选的发布版本'); return; }
  try {
    const r = await api('POST', '/api/performances', { versionId, operator });
    $('#c-launch').classList.add('hidden');
    C.perfId = r.performanceId;
    await refreshPerfList();
    $('#c-perf-select').value = C.perfId;
    $('#c-request-no').value = genRequestNo();
    await loadPerformance();
    toast('演出已启动', `演出 #${r.performanceId} 基于版本 #${r.versionId} 的不可变快照。`);
  } catch (err) { illegal(err.message); }
});

$('#c-perf-select').addEventListener('change', () => {
  C.perfId = Number($('#c-perf-select').value) || null;
  loadPerformance();
});
$('#c-refresh').addEventListener('click', refreshPerfList);
$('#c-gen-no').addEventListener('click', () => { $('#c-request-no').value = genRequestNo(); });

async function loadPerformance(silent) {
  if (!C.perfId) {
    $('#c-stage').classList.add('hidden');
    $('#c-empty').classList.remove('hidden');
    return;
  }
  try {
    C.state = await api('GET', `/api/performances/${C.perfId}`);
    $('#c-stage').classList.remove('hidden');
    $('#c-empty').classList.add('hidden');
    renderConsole();
  } catch (err) {
    if (!silent) illegal(err.message);
  }
}

function renderConsole() {
  const { performance: p, version, progressNo, items } = C.state;
  $('#c-title').textContent = `${version.showName} — v${version.versionNo}${version.label ? ' · ' + version.label : ''}`;
  $('#c-sub').textContent =
    `演出 #${p.id} · 操作员 ${esc(p.operator)} · 开始 ${fmtTime(p.started_at)}${p.ended_at ? ' · 结束 ' + fmtTime(p.ended_at) : ''}`;
  $('#c-progress').textContent = progressNo;
  const st = $('#c-status');
  st.textContent = p.status === 'running' ? '进行中' : '已结束';
  st.className = `status-badge status-${p.status}`;

  const currentSeq = items.filter((i) => i.state === 'pending').sort((a, b) => a.seq - b.seq)[0]?.seq ?? null;
  $('#c-rows').innerHTML = items.map((c) => {
    const cls = c.state === 'pending' && c.seq === currentSeq ? 'current'
      : c.state === 'executed' ? 'done-executed'
      : c.state === 'skipped' ? 'done-skipped' : '';
    const label = { pending: '待处理', executed: '已执行', skipped: '已跳过' }[c.state];
    return `<tr class="${cls}">
      <td class="seqcell">${c.seq}${c.seq === currentSeq ? ' ◄' : ''}</td>
      <td><span class="typ typ-${c.cueType}">${TYPE_LABEL[c.cueType]}</span></td>
      <td><b>${esc(c.title)}</b><div class="meta">${esc(c.instruction)}</div></td>
      <td>${c.waitSecs} 秒</td>
      <td>${fmtClock(c.plannedSecs)}</td>
      <td class="st-${c.state}">${label}</td>
    </tr>`;
  }).join('');

  const running = p.status === 'running';
  const lastDone = [...items].filter((i) => i.state !== 'pending')
    .sort((a, b) => (b.processedSeq || 0) - (a.processedSeq || 0))[0];
  const undoable = running && lastDone && lastDone.state === 'skipped';
  $('#c-exec').disabled = !running || currentSeq == null;
  $('#c-skip').disabled = !running || currentSeq == null;
  $('#c-undo').disabled = !undoable;
  $('#c-end').disabled = !running;
  $('#c-exec').dataset.seq = currentSeq ?? '';
  $('#c-skip').dataset.seq = currentSeq ?? '';
  $('#c-undo').title = undoable ? `将撤销对 #${lastDone.seq}「${lastDone.title}」的跳过`
    : '仅当最后一次处理为跳过、且下一条尚未处理时可撤销；执行过的提示不能撤销';
}

async function sendOp(action) {
  if (!C.state) return;
  const requestNo = $('#c-request-no').value.trim();
  if (!requestNo) { illegal('请填写或生成操作请求号'); return; }
  const now = Date.now();
  if (now - C.lastAction < 350) { toast('操作过于频繁', '请稍候再试', 'warn'); return; }
  C.lastAction = now;

  const body = { requestNo, action, progressNo: C.state.progressNo };
  if (action === 'execute' || action === 'skip') body.cueSeq = Number($(`#c-${action === 'execute' ? 'exec' : 'skip'}`).dataset.seq);
  try {
    const r = await api('POST', `/api/performances/${C.perfId}/ops`, body);
    if (r.items) C.state.items = r.items;
    C.state.progressNo = r.progressNo;
    C.state.performance.status = r.status;
    renderConsole();
    const names = { executed: '已确认执行', skipped: '已跳过', undone: '已撤销跳过（回到该提示）', ended: '演出已结束' };
    toast(`操作成功：${names[r.result] || r.result}`,
      `${r.replayed ? '同号同内容重试，返回原结果 · ' : ''}请求号 ${r.requestNo} · 当前进度 ${r.progressNo}`,
      r.replayed ? 'warn' : 'ok');
    if (!r.replayed) $('#c-request-no').value = genRequestNo();
  } catch (err) {
    // Stale / ahead progress -> server returns current items & progress
    if (err.data && (err.code === 'STALE_PROGRESS' || err.code === 'AHEAD_PROGRESS')) {
      if (err.data.items) {
        C.state.items = err.data.items;
        C.state.progressNo = err.data.currentProgress;
        renderConsole();
      }
      toast('⚠ 进度号冲突，状态未改变', `${err.message}（请求号 ${requestNo} 可继续使用）`, 'warn', 7000);
    } else {
      illegal(`${err.message}（请求号 ${requestNo}，状态未改变）`);
      loadPerformance(true);
    }
  }
}

$('#c-exec').addEventListener('click', () => sendOp('execute'));
$('#c-skip').addEventListener('click', () => sendOp('skip'));
$('#c-undo').addEventListener('click', () => sendOp('undo'));
$('#c-end').addEventListener('click', async () => {
  if (!confirm('确认结束本场演出？结束后不能再操作。')) return;
  sendOp('end');
});

// Background polling: keeps "所见进度号" honest in multi-operator situations.
setInterval(() => {
  if ($('#tab-console').classList.contains('active') && C.perfId) loadPerformance(true);
}, 1500);

/* ================= logs ================= */
const OUT_LABEL = {
  executed: '确认执行', skipped: '跳过', undone: '撤销跳过', ended: '结束演出',
  rejected: '拒绝', conflict: '进度冲突', idempotent: '幂等返回',
};
const ACTION_LABEL = { execute: '执行', skip: '跳过', undo: '撤销', end: '结束' };

async function loadLogs() {
  const pid = $('#l-perf-select').value;
  let { logs } = await api('GET', pid ? `/api/logs?performanceId=${pid}` : '/api/logs');
  if ($('#l-hide-idempotent').checked) logs = logs.filter((l) => l.outcome !== 'idempotent');
  $('#l-rows').innerHTML = logs.map((l) => {
    const bad = l.outcome === 'rejected';
    const conflict = l.outcome === 'conflict';
    const where = l.show_name ? `${esc(l.show_name)} v${l.version_no}#${l.performance_id ?? '-'}` : '-';
    return `<tr>
      <td>${fmtTime(l.created_at)}</td>
      <td>${where}</td>
      <td>${esc(l.operator)}</td>
      <td style="font-family:ui-monospace,monospace;font-size:11px">${esc(l.request_no || '-')}</td>
      <td>${ACTION_LABEL[l.action] || l.action}</td>
      <td>${l.cue_seq ?? '-'}</td>
      <td>${l.client_progress ?? '-'} → ${l.server_progress ?? '-'}</td>
      <td class="out-${l.outcome}">${OUT_LABEL[l.outcome] || l.outcome}</td>
      <td class="${bad ? 'reason-bad' : conflict ? 'out-conflict' : ''}">${esc(l.reason || '')}${l.detail ? ` <span class="meta">(${esc(l.detail)})</span>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty-note">暂无记录</td></tr>';
}
$('#l-refresh').addEventListener('click', loadLogs);
$('#l-perf-select').addEventListener('change', loadLogs);
$('#l-hide-idempotent').addEventListener('change', loadLogs);

/* ================= boot ================= */
(async function boot() {
  try {
    const shows = await loadShowSelect();
    if (shows.length) {
      $('#ed-show-select').value = shows[0].id;
      await loadEditorShow(shows[0].id);
    }
    refreshPerfList();
  } catch (err) {
    illegal('初始化失败：' + err.message);
  }
})();
