'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const d = db();

/* ----------------------------- helpers ----------------------------- */

const TYPES = { light: '灯光', sound: '音效', scene: '换景' };

function httpErr(status, code, reason) {
  const e = new Error(reason);
  e.status = status;
  e.code = code;
  e.reason = reason;
  return e;
}

// Validate a full cue list as supplied by the stage manager's editor.
// Order is the array order; planned times are recomputed by the caller.
// Negative or non-integer waits are rejected.
function validateCues(input) {
  if (!Array.isArray(input)) throw httpErr(400, 'INVALID_CUES', '提示列表必须是数组');
  if (input.length > 500) throw httpErr(400, 'TOO_MANY_CUES', '单次保存的提示不能超过 500 条');
  return input.map((c, i) => {
    const cueType = String(c.cueType || c.cue_type || '').trim();
    const title = String(c.title || '').trim();
    const rawWait = c.waitSecs ?? c.wait_secs;
    const wait = Number(rawWait);
    const instruction = String(c.instruction || '').trim();
    if (!TYPES[cueType]) throw httpErr(400, 'INVALID_TYPE', `第 ${i + 1} 条提示类型非法（只允许 灯光/音效/换景）`);
    if (!title) throw httpErr(400, 'EMPTY_TITLE', `第 ${i + 1} 条提示缺少标题`);
    if (!Number.isFinite(wait) || !Number.isInteger(wait) || wait < 0) {
      throw httpErr(400, 'NEGATIVE_WAIT',
        `第 ${i + 1} 条「${title}」的相对等待时长非法：等待时长不能为负数（收到：${JSON.stringify(rawWait)}）`);
    }
    if (instruction.length > 1000) throw httpErr(400, 'INSTRUCTION_TOO_LONG', `第 ${i + 1} 条操作说明过长`);
    return { cueType, title, waitSecs: wait, instruction };
  });
}

function draftCueRows(showId) {
  return d.prepare('SELECT * FROM cues WHERE show_id=? ORDER BY seq, id').all(showId);
}

function decorate(rows) {
  let acc = 0;
  return rows.map((r) => {
    acc += r.wait_secs;
    return {
      seq: r.seq,
      cueType: r.cue_type,
      title: r.title,
      waitSecs: r.wait_secs,
      instruction: r.instruction,
      plannedSecs: acc,
      state: r.state,
      processedSeq: r.processed_seq ?? null,
    };
  });
}

function payloadHash(action, cueSeq) {
  return crypto.createHash('sha1').update(`${action}|${cueSeq ?? ''}`).digest('hex');
}

function getShow(id) {
  const show = d.prepare('SELECT * FROM shows WHERE id=?').get(id);
  if (!show) throw httpErr(404, 'NOT_FOUND', '场次不存在');
  return show;
}
function getVersion(id) {
  const v = d.prepare(
    `SELECT v.*, s.name AS show_name FROM versions v JOIN shows s ON s.id=v.show_id WHERE v.id=?`
  ).get(id);
  if (!v) throw httpErr(404, 'NOT_FOUND', '版本不存在');
  return v;
}
function getPerformance(id) {
  const p = d.prepare('SELECT * FROM performances WHERE id=?').get(id);
  if (!p) throw httpErr(404, 'NOT_FOUND', '演出不存在');
  return p;
}

function insertLog(o) {
  d.prepare(`INSERT INTO op_logs
    (performance_id, version_id, operator, request_no, action, cue_seq, client_progress, outcome, reason, detail, server_progress)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.performanceId ?? null, o.versionId ?? null, o.operator || '',
    o.requestNo ?? null, o.action, o.cueSeq ?? null,
    o.clientProgress ?? null, o.outcome, o.reason || '', o.detail || '',
    o.serverProgress ?? null
  );
}

/* ----------------------------- meta / shows ----------------------------- */

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/shows', (req, res) => {
  const shows = d.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM cues c WHERE c.show_id=s.id) AS cue_count,
      (SELECT MAX(version_no) FROM versions v WHERE v.show_id=s.id) AS latest_version
    FROM shows s ORDER BY s.id`).all();
  res.json({ shows });
});

app.post('/api/shows', (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw httpErr(400, 'EMPTY_NAME', '场次名称不能为空');
    const id = d.prepare('INSERT INTO shows (name) VALUES (?)').run(name).lastInsertRowid;
    res.status(201).json({ id, name });
  } catch (e) { next(e); }
});

app.get('/api/shows/:id', (req, res, next) => {
  try {
    const show = getShow(req.params.id);
    const cues = decorate(draftCueRows(show.id));
    const totalSecs = cues.length ? cues[cues.length - 1].plannedSecs : 0;
    const versions = d.prepare('SELECT * FROM versions WHERE show_id=? ORDER BY version_no DESC').all(show.id);
    res.json({ show, cues, totalSecs, versions });
  } catch (e) { next(e); }
});

// Replace the whole draft cue list. Array order = cue order; planned times
// are recomputed. Negative waits are refused (nothing is written).
app.put('/api/shows/:id/cues', (req, res, next) => {
  try {
    const show = getShow(req.params.id);
    const cues = validateCues(req.body.cues);
    const replace = d.transaction(() => {
      d.prepare('DELETE FROM cues WHERE show_id=?').run(show.id);
      const ins = d.prepare(
        'INSERT INTO cues (show_id, seq, cue_type, title, wait_secs, instruction) VALUES (?,?,?,?,?,?)'
      );
      cues.forEach((c, i) => ins.run(show.id, i + 1, c.cueType, c.title, c.waitSecs, c.instruction));
      d.prepare("UPDATE shows SET updated_at=datetime('now') WHERE id=?").run(show.id);
    });
    replace();
    const rows = decorate(draftCueRows(show.id));
    const totalSecs = rows.length ? rows[rows.length - 1].plannedSecs : 0;
    res.json({ ok: true, cues: rows, totalSecs });
  } catch (e) { next(e); }
});

/* ----------------------------- versions ----------------------------- */

// Publish: snapshot the current draft into an immutable version.
// Later draft edits never touch version_items.
app.post('/api/shows/:id/publish', (req, res, next) => {
  try {
    const show = getShow(req.params.id);
    const rows = draftCueRows(show.id);
    if (rows.length === 0) throw httpErr(400, 'EMPTY_CUELIST', '草稿中没有任何提示，无法发布版本');
    const label = String(req.body.label || '').trim();
    const createdBy = String(req.body.createdBy || '操作员').trim();

    const tx = d.transaction(() => {
      const nextNo = (d.prepare('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM versions WHERE show_id=?').get(show.id)).n;
      const vid = d.prepare(
        'INSERT INTO versions (show_id, version_no, label, created_by, total_secs) VALUES (?,?,?,?,?)'
      ).run(show.id, nextNo, label, createdBy, 0).lastInsertRowid;
      const ins = d.prepare(
        'INSERT INTO version_items (version_id, seq, cue_type, title, wait_secs, instruction, planned_secs) VALUES (?,?,?,?,?,?,?)'
      );
      let acc = 0;
      rows.forEach((r) => {
        acc += r.wait_secs;
        ins.run(vid, r.seq, r.cue_type, r.title, r.wait_secs, r.instruction, acc);
      });
      d.prepare('UPDATE versions SET total_secs=? WHERE id=?').run(acc, vid);
      return { vid, nextNo, acc };
    });
    const { vid, nextNo, acc } = tx();
    res.status(201).json({ id: vid, versionNo: nextNo, totalSecs: acc });
  } catch (e) { next(e); }
});

app.get('/api/shows/:id/versions', (req, res, next) => {
  try {
    const show = getShow(req.params.id);
    const versions = d.prepare(`
      SELECT v.*, (SELECT COUNT(*) FROM version_items vi WHERE vi.version_id=v.id) AS item_count
      FROM versions v WHERE v.show_id=? ORDER BY v.version_no DESC`).all(show.id);
    res.json({ versions });
  } catch (e) { next(e); }
});

app.get('/api/versions/:id', (req, res, next) => {
  try {
    const v = getVersion(req.params.id);
    const items = decorate(d.prepare('SELECT * FROM version_items WHERE version_id=? ORDER BY seq').all(v.id));
    res.json({ version: v, items });
  } catch (e) { next(e); }
});

/* ----------------------------- performances ----------------------------- */

app.post('/api/performances', (req, res, next) => {
  try {
    const versionId = Number(req.body.versionId);
    const operator = String(req.body.operator || '操作员').trim();
    if (!Number.isInteger(versionId)) throw httpErr(400, 'BAD_VERSION', '缺少有效的版本号');
    const version = getVersion(versionId);
    const items = d.prepare('SELECT * FROM version_items WHERE version_id=? ORDER BY seq').all(versionId);
    if (items.length === 0) throw httpErr(400, 'EMPTY_VERSION', '该版本没有提示，无法启动演出');

    const pid = d.transaction(() => {
      const id = d.prepare('INSERT INTO performances (version_id, operator) VALUES (?,?)')
        .run(versionId, operator).lastInsertRowid;
      const ins = d.prepare(`INSERT INTO performance_items
        (performance_id, seq, cue_type, title, wait_secs, instruction, planned_secs)
        VALUES (?,?,?,?,?,?,?)`);
      items.forEach((it) => ins.run(id, it.seq, it.cue_type, it.title, it.wait_secs, it.instruction, it.planned_secs));
      return id;
    })();
    res.status(201).json({ performanceId: pid, versionId, operator });
  } catch (e) { next(e); }
});

app.get('/api/performances', (req, res) => {
  const list = d.prepare(`
    SELECT p.*, v.version_no, v.label AS version_label, s.id AS show_id, s.name AS show_name
    FROM performances p
    JOIN versions v ON v.id=p.version_id
    JOIN shows s ON s.id=v.show_id
    ORDER BY p.id DESC LIMIT 100`).all();
  res.json({ performances: list });
});

function progressOf(pid) {
  return d.prepare("SELECT COUNT(*) AS c FROM performance_items WHERE performance_id=? AND state!='pending'").get(pid).c;
}
function itemsOf(pid) {
  return decorate(d.prepare('SELECT * FROM performance_items WHERE performance_id=? ORDER BY seq').all(pid));
}

app.get('/api/performances/:id', (req, res, next) => {
  try {
    const p = getPerformance(req.params.id);
    const version = getVersion(p.version_id);
    const items = itemsOf(p.id);
    res.json({
      performance: p,
      version: { id: version.id, versionNo: version.version_no, label: version.label, showName: version.show_name },
      progressNo: progressOf(p.id),
      items,
    });
  } catch (e) { next(e); }
});

/*
 * Operation protocol.
 * Body: { requestNo, action: execute|skip|undo|end, cueSeq?, progressNo, operator? }
 *  - requestNo idempotency: same no + same content -> original result; same no + different content -> rejected
 *  - progressNo: stale (< server) -> current progress returned, state unchanged
 *  - undo: only the most recent skip while the next cue is unprocessed; executed cues can never be undone
 */
app.post('/api/performances/:id/ops', (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    const perf = getPerformance(pid);
    const requestNo = String(req.body.requestNo || '').trim();
    const action = String(req.body.action || '').trim();
    const cueSeq = req.body.cueSeq == null ? null : Number(req.body.cueSeq);
    const clientProgress = Number(req.body.progressNo);
    const operator = String(req.body.operator || perf.operator || '操作员').trim();
    const ACTIONS = ['execute', 'skip', 'undo', 'end'];

    if (!requestNo) throw httpErr(400, 'NO_REQUEST_NO', '缺少操作请求号 requestNo');
    if (!ACTIONS.includes(action)) throw httpErr(400, 'BAD_ACTION', `非法操作类型：${action}`);
    if (!Number.isInteger(clientProgress) || clientProgress < 0)
      throw httpErr(400, 'BAD_PROGRESS', '进度号 progressNo 必须是非负整数');
    if ((action === 'execute' || action === 'skip') && (!Number.isInteger(cueSeq) || cueSeq < 1))
      throw httpErr(400, 'NO_CUE_SEQ', `${action} 操作必须指定提示序号 cueSeq`);

    const hash = payloadHash(action, cueSeq);
    const versionId = perf.version_id;

    // 1) Idempotent replay / same-no-different-content
    const dup = d.prepare('SELECT * FROM op_requests WHERE performance_id=? AND request_no=?').get(pid, requestNo);
    if (dup) {
      if (dup.payload_hash !== hash) {
        insertLog({
          performanceId: pid, versionId, operator, requestNo, action, cueSeq,
          clientProgress, outcome: 'rejected',
          reason: '同号异内容：该请求号已用于不同的操作，拒绝执行',
          detail: `原操作 action=${dup.action}, cueSeq=${dup.cueSeq ?? '-'}`,
          serverProgress: progressOf(pid),
        });
        throw httpErr(409, 'REQUEST_CONFLICT',
          `请求号 ${requestNo} 已用于其他操作（${dup.action} #${dup.cue_seq ?? '-'}），同号异内容拒绝`);
      }
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq,
        clientProgress, outcome: 'idempotent',
        reason: '同号同内容重试，返回原结果',
        detail: `原结果=${dup.result} @进度${dup.applied_progress}`,
        serverProgress: dup.applied_progress,
      });
      return res.json({
        replayed: true, requestNo, action, cueSeq: dup.cue_seq,
        result: dup.result, progressNo: dup.applied_progress,
        status: perf.status, serverTime: dup.applied_at,
      });
    }

    // 2) Ended performance
    if (perf.status !== 'running') {
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq,
        clientProgress, outcome: 'rejected', reason: '演出已结束，不能再操作',
        serverProgress: progressOf(pid),
      });
      throw httpErr(409, 'PERFORMANCE_ENDED', '该演出已经结束，不能接受新的操作');
    }

    const progress = progressOf(pid);

    // 3) Stale progress -> return current progress, do not mutate
    if (clientProgress < progress) {
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq,
        clientProgress, outcome: 'conflict',
        reason: `进度号过期：所见进度 ${clientProgress}，服务器当前进度 ${progress}`,
        serverProgress: progress,
      });
      return res.status(409).json({
        error: 'STALE_PROGRESS',
        reason: `进度号已过期（所见 ${clientProgress} < 当前 ${progress}），请按当前进度操作`,
        currentProgress: progress, items: itemsOf(pid),
      });
    }
    if (clientProgress > progress) {
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq,
        clientProgress, outcome: 'conflict',
        reason: `进度号超前：所见进度 ${clientProgress}，服务器当前进度 ${progress}`,
        serverProgress: progress,
      });
      return res.status(409).json({
        error: 'AHEAD_PROGRESS',
        reason: `进度号超前（所见 ${clientProgress} > 当前 ${progress}），请刷新到最新进度`,
        currentProgress: progress, items: itemsOf(pid),
      });
    }

    /* ---------- application of the operation (transactional) ---------- */
    const apply = d.transaction(() => {
      let result;
      let targetSeq = cueSeq;

      if (action === 'end') {
        d.prepare("UPDATE performances SET status='ended', ended_at=datetime('now') WHERE id=?").run(pid);
        result = 'ended';
      } else if (action === 'undo') {
        // The processed cues are always a prefix; undo targets its last cue.
        const last = d.prepare(
          "SELECT * FROM performance_items WHERE performance_id=? AND state!='pending' ORDER BY processed_seq DESC LIMIT 1"
        ).get(pid);
        if (!last) throw httpErr(400, 'NOTHING_TO_UNDO', '没有可撤销的提示（尚未处理任何提示）');
        if (last.state !== 'skipped') {
          throw httpErr(400, 'EXECUTED_NOT_UNDOABLE',
            `最后一次处理是「执行」#${last.seq}「${last.title}」，执行过的提示不能撤销`);
        }
        // "下一条尚未处理" — the next cue must be pending. Since processed cues
        // are a prefix and last is its tail, this holds unless the show is fully
        // consumed; a trailing skipped cue is still undoable.
        const next = d.prepare(
          'SELECT * FROM performance_items WHERE performance_id=? AND seq>? ORDER BY seq LIMIT 1'
        ).get(pid, last.seq);
        if (next && next.state !== 'pending') {
          throw httpErr(400, 'NEXT_ALREADY_PROCESSED', '下一条提示已被处理，不能撤销该跳过');
        }
        d.prepare("UPDATE performance_items SET state='pending', processed_seq=NULL WHERE id=?").run(last.id);
        targetSeq = last.seq;
        result = 'undone';
      } else {
        // execute | skip -> first pending cue
        const pending = d.prepare(
          "SELECT * FROM performance_items WHERE performance_id=? AND state='pending' ORDER BY seq LIMIT 1"
        ).get(pid);
        if (!pending) throw httpErr(400, 'NO_PENDING_CUE', '当前没有待处理提示（所有提示均已处理，可结束演出）');
        if (cueSeq !== pending.seq) {
          throw httpErr(400, 'CUE_NOT_CURRENT',
            `#${cueSeq} 不是当前待处理提示，当前应处理 #${pending.seq}「${pending.title}」`);
        }
        const state = action === 'execute' ? 'executed' : 'skipped';
        result = state;
        d.prepare('UPDATE performance_items SET state=?, processed_seq=? WHERE id=?')
          .run(state, progress + 1, pending.id);
      }

      const newProgress = progressOf(pid);
      d.prepare(`INSERT INTO op_requests
        (performance_id, request_no, action, cue_seq, payload_hash, result, applied_progress)
        VALUES (?,?,?,?,?,?,?)`).run(pid, requestNo, action, targetSeq, hash, result, newProgress);
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq: targetSeq,
        clientProgress, outcome: result,
        reason: result === 'executed' ? '确认执行' : result === 'skipped' ? '跳过' : result === 'undone' ? '撤销最后一次跳过' : '结束演出',
        serverProgress: newProgress,
      });
      return { result, targetSeq, newProgress };
    });

    let out;
    try {
      out = apply();
    } catch (e) {
      // Business rejection inside tx (tx rolled back): record and surface.
      insertLog({
        performanceId: pid, versionId, operator, requestNo, action, cueSeq,
        clientProgress, outcome: 'rejected', reason: e.reason || e.message,
        serverProgress: progressOf(pid),
      });
      throw e;
    }

    res.json({
      replayed: false, requestNo, action, cueSeq: out.targetSeq,
      result: out.result, progressNo: out.newProgress,
      status: action === 'end' ? 'ended' : 'running',
      items: itemsOf(pid),
    });
  } catch (e) { next(e); }
});

/* ----------------------------- logs ----------------------------- */

app.get('/api/logs', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.performanceId) { where.push('l.performance_id=?'); params.push(Number(req.query.performanceId)); }
  if (req.query.showId) { where.push('s.id=?'); params.push(Number(req.query.showId)); }
  const sql = `
    SELECT l.*, p.version_id, v.version_no, s.name AS show_name
    FROM op_logs l
    LEFT JOIN performances p ON p.id=l.performance_id
    LEFT JOIN versions v ON v.id=COALESCE(p.version_id, l.version_id)
    LEFT JOIN shows s ON s.id=v.show_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.id DESC LIMIT 500`;
  res.json({ logs: d.prepare(sql).all(...params) });
});

/* ----------------------------- error handler ----------------------------- */

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.code || 'INTERNAL',
    reason: err.reason || err.message || '服务器内部错误',
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cue Rail listening on http://0.0.0.0:${PORT}`);
});
