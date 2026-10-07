'use strict';
const BASE = 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, extra ?? ''); }
}
async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log('— 编排：拒绝负时长 / 重算累计时间 —');
  const { json: { shows } } = await req('GET', '/api/shows');
  const showA = shows.find((s) => s.name.includes('雷雨'));
  let r = await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [
    { cueType: 'light', title: 'A', waitSecs: 0, instruction: '' },
    { cueType: 'sound', title: 'B', waitSecs: -5, instruction: '' },
  ] });
  ok('负时长被 400 拒绝', r.status === 400 && r.json.error === 'NEGATIVE_WAIT', r.json);
  r = await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [
    { cueType: 'light', title: '第二条', waitSecs: 10, instruction: '' },
    { cueType: 'sound', title: '第一条', waitSecs: 2, instruction: '' },
  ] });
  ok('换序保存成功并累计重算', r.status === 200 &&
    r.json.cues[0].title === '第二条' && r.json.cues[0].plannedSecs === 10 &&
    r.json.cues[1].plannedSecs === 12 && r.json.totalSecs === 12, r.json);

  // restore a 5-cue draft and publish v2
  await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [
    { cueType: 'light', title: '开场暗场', waitSecs: 0, instruction: 'x' },
    { cueType: 'sound', title: '雷声远响', waitSecs: 3, instruction: 'x' },
    { cueType: 'light', title: '台灯亮起', waitSecs: 8, instruction: 'x' },
    { cueType: 'scene', title: '沙发移景', waitSecs: 5, instruction: 'x' },
    { cueType: 'sound', title: '雨声加强', waitSecs: 12, instruction: 'x' },
  ] });
  const pub = await req('POST', `/api/shows/${showA.id}/publish`, { label: '测试v2', createdBy: '场记' });
  ok('发布 v2', pub.status === 201 && pub.json.versionNo === 2, pub.json);
  const v2Id = pub.json.id;

  console.log('— 草稿改动不影响已发布 v1 / 新版本 —');
  await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [
    { cueType: 'light', title: '草稿被改得面目全非', waitSecs: 99, instruction: '' },
  ] });
  const v1 = await req('GET', '/api/versions/1');
  ok('v1 快照保持 5 条且内容不变', v1.json.items.length === 5 && v1.json.items[0].title === '开场暗场', v1.json.items.map(i => i.title));

  console.log('— 启动演出（基于 v1）—');
  const started = await req('POST', '/api/performances', { versionId: 1, operator: '张三' });
  ok('演出启动', started.status === 201, started.json);
  const pid = started.json.performanceId;
  const no = (n) => 'R-' + pid + '-' + n;
  const op = (n, action, cueSeq, progressNo) =>
    req('POST', `/api/performances/${pid}/ops`,
      { requestNo: no(n), action, cueSeq, progressNo, operator: '张三' });

  console.log('— 执行 / 幂等 / 同号异内容 / 过期进度 —');
  r = await op('a', 'execute', 1, 0);
  ok('执行 #1，进度变 1', r.status === 200 && r.json.result === 'executed' && r.json.progressNo === 1, r.json);
  r = await op('a', 'execute', 1, 0);
  ok('同号同内容重试 → 原结果 replayed', r.status === 200 && r.json.replayed === true && r.json.result === 'executed' && r.json.progressNo === 1, r.json);
  r = await op('a', 'skip', 1, 0);
  ok('同号异内容 → 409 拒绝', r.status === 409 && r.json.error === 'REQUEST_CONFLICT', r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: 'R-STALE', action: 'execute', cueSeq: 2, progressNo: 0, operator: '张三' });
  ok('过期进度号 0 → 409 STALE 且返回当前进度 1，状态不变',
    r.status === 409 && r.json.error === 'STALE_PROGRESS' && r.json.currentProgress === 1, r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: 'R-AHEAD', action: 'execute', cueSeq: 2, progressNo: 9, operator: '张三' });
  ok('超前进度号 9 → 409 AHEAD', r.status === 409 && r.json.error === 'AHEAD_PROGRESS', r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('wrongseq'), action: 'execute', cueSeq: 5, progressNo: 1, operator: '张三' });
  ok('对非当前提示(#5)操作 → 拒绝并指明当前 #2',
    r.status === 400 && r.json.error === 'CUE_NOT_CURRENT' && r.json.reason.includes('#2'), r.json);

  console.log('— 跳过 / 撤销链 / 执行不可撤销 —');
  r = await op('b', 'skip', 2, 1);
  ok('跳过 #2，进度变 2', r.status === 200 && r.json.result === 'skipped' && r.json.progressNo === 2, r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('undo1'), action: 'undo', progressNo: 2, operator: '张三' });
  ok('撤销最后一次跳过 → 回到 #2，进度回 1',
    r.status === 200 && r.json.result === 'undone' && r.json.cueSeq === 2 && r.json.progressNo === 1, r.json);
  r = await op('c', 'execute', 2, 1);
  ok('执行 #2', r.status === 200 && r.json.result === 'executed' && r.json.progressNo === 2, r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('undo2'), action: 'undo', progressNo: 2, operator: '张三' });
  ok('执行过的提示不能撤销 → 400', r.status === 400 && r.json.error === 'EXECUTED_NOT_UNDOABLE', r.json);

  r = await op('d', 'skip', 3, 2);  // skip 3, prog 3
  r = await op('e', 'skip', 4, 3);  // skip 4, prog 4
  ok('连续跳过 #3 #4', r.status === 200 && r.json.progressNo === 4);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('undo3'), action: 'undo', progressNo: 4, operator: '张三' });
  ok('撤销 #4 跳过（下一条#5未处理）', r.status === 200 && r.json.cueSeq === 4 && r.json.progressNo === 3, r.json);
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('undo4'), action: 'undo', progressNo: 3, operator: '张三' });
  ok('继续撤销 #3 跳过', r.status === 200 && r.json.cueSeq === 3 && r.json.progressNo === 2, r.json);

  console.log('— 结束演出后拒绝操作；幂等号不影响状态 —');
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: no('end'), action: 'end', progressNo: 2, operator: '张三' });
  ok('结束演出', r.status === 200 && r.json.result === 'ended');
  r = await req('POST', `/api/performances/${pid}/ops`,
    { requestNo: 'R-NEW', action: 'execute', cueSeq: 3, progressNo: 2, operator: '张三' });
  ok('已结束 → 拒绝', r.status === 409 && r.json.error === 'PERFORMANCE_ENDED', r.json);
  r = await op('a', 'execute', 1, 0);
  ok('结束后同号同内容仍返回原结果', r.status === 200 && r.json.replayed === true, r.json);

  console.log('— 边界：全部跳过后（尾部跳过）仍可撤销 —');
  const s2 = await req('POST', '/api/performances', { versionId: 1, operator: '李四' });
  const p2 = s2.json.performanceId;
  const op2 = (n, action, cueSeq, progressNo) =>
    req('POST', `/api/performances/${p2}/ops`,
      { requestNo: `Q-${n}`, action, cueSeq, progressNo, operator: '李四' });
  for (const [seq, prog] of [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]) {
    const x = await op2('s' + seq, 'skip', seq, prog);
    if (x.status !== 200) { console.log('  skip fail', x.json); break; }
  }
  let st = await req('GET', `/api/performances/${p2}`);
  ok('5 条全部跳过，进度 5', st.json.progressNo === 5, st.json.progressNo);
  r = await op2('undo', 'undo', null, 5);
  ok('尾部跳过可撤销，回到 #5，进度 4', r.status === 200 && r.json.cueSeq === 5 && r.json.progressNo === 4, r.json);

  console.log('— 进行中的演出不受草稿变更影响（快照隔离）—');
  ok('演出中的条目来自 v1（5条原始标题）',
    st.json.items[0].title === '开场暗场' && st.json.items.length === 5);

  console.log('— 操作记录审计 —');
  const { json: { logs } } = await req('GET', `/api/logs?performanceId=${pid}`);
  const ops = logs.filter((l) => l.outcome !== 'idempotent');
  ok('记录包含操作员/版本/时间/结果', ops.every((l) => l.operator && l.version_id && l.created_at && l.outcome));
  ok('拒绝与冲突也有记录和原因',
    logs.some((l) => l.outcome === 'rejected' && l.reason) &&
    logs.some((l) => l.outcome === 'conflict' && l.reason.includes('过期')));
  ok('幂等重试单独记录为 idempotent', logs.some((l) => l.outcome === 'idempotent'));

  console.log('— 输入校验 —');
  r = await req('POST', '/api/performances', { versionId: 99999, operator: 'x' });
  ok('不存在版本 → 404', r.status === 404);
  r = await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [] });
  ok('空草稿允许保存', r.status === 200);
  const pubEmpty = await req('POST', `/api/shows/${showA.id}/publish`, {});
  ok('空草稿禁止发布', pubEmpty.status === 400 && pubEmpty.json.error === 'EMPTY_CUELIST', pubEmpty.json);
  // restore draft for manual UI checking
  await req('PUT', `/api/shows/${showA.id}/cues`, { cues: [
    { cueType: 'light', title: '开场暗场', waitSecs: 0, instruction: '观众入场完毕' },
    { cueType: 'sound', title: '雷声远响', waitSecs: 3, instruction: '远雷 30%' },
    { cueType: 'light', title: '台灯亮起', waitSecs: 8, instruction: '暖光' },
  ] });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
