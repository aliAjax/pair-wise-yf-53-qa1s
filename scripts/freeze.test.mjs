// 用 node 内置 test runner 验证冻结批次的核心语义（纯领域模块，无 DOM）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('/workspace/node_modules/esbuild/lib/main.js');
const result = esbuild.buildSync({
  entryPoints: ['/workspace/app/store/freeze.ts'],
  write: false,
  format: 'esm',
  loader: { '.ts': 'ts' }
});
writeFileSync('/tmp/freeze-test.mjs', result.outputFiles[0].text);
const mod = await import(pathToFileURL('/tmp/freeze-test.mjs').href + `?t=${Date.now()}`);
const {
  createBatch, applyGateOutcome, invalidateBatch, remainingItems, mergeLateSubmission, planFingerprint,
  idempotencyKeyFor, migrateLegacy, completeIfDone, findTrain, activeBatch, addAudit
} = mod;

function makeTrain() {
  return {
    id: 't1', name: 'T', freezeAt: '2026-10-01 10:00', status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: 'a', dependency: 'shared-ui@4', version: '1.0', status: 'confirmed' },
      { id: 'g2', repository: 'gateway', owner: 'b', dependency: 'auth-sdk@2', version: '2.0', status: 'pending' },
      { id: 'g3', repository: 'data-sync', owner: 'c', dependency: 'gateway@2', version: '3.0', status: 'blocked' }
    ],
    blockers: [
      { id: 'b1', title: '关键阻断', severity: 'critical', resolved: false },
      { id: 'b2', title: '普通阻断', severity: 'warning', resolved: false }
    ],
    audit: []
  };
}
function makeState(train = makeTrain()) {
  return { schema: 2, activeId: train.id, trains: [train], batches: [] };
}

test('开始批次固定仓库顺序、门禁版本与阻断项快照', () => {
  const train = makeTrain();
  const batch = createBatch(train, '值班员甲', '10:00');
  assert.deepEqual(batch.order.map((i) => i.gateId), ['g1', 'g2', 'g3']);
  assert.equal(batch.items[2].version, '3.0');
  assert.equal(batch.blockers[0].resolved, false);
  assert.equal(batch.items[0].status, 'confirmed'); // 已确认门禁沿用
  assert.equal(batch.items[1].status, 'pending');
  // 指纹幂等键稳定
  assert.equal(idempotencyKeyFor(train.id, planFingerprint(train)), batch.idempotencyKey);
});

test('失败保留已处理仓库，只重试未完成项；关闭阻断后重试成功', () => {
  const train = makeTrain();
  const state = makeState(train);
  const batch = createBatch(train, '甲');
  state.batches.push(batch);

  // g3 blocked 且关键阻断未解 -> 失败
  let r = applyGateOutcome(train, batch, 'g3', 'confirm', '甲', '10:01');
  assert.equal(r.ok, false);
  assert.equal(batch.items.find((i) => i.gateId === 'g3').status, 'failed');
  assert.equal(train.gates.find((g) => g.id === 'g3').status, 'blocked');

  // g2 先确认成功
  r = applyGateOutcome(train, batch, 'g2', 'confirm', '甲', '10:02');
  assert.equal(r.ok, true);
  assert.deepEqual(remainingItems(batch).map((i) => i.gateId), ['g3']);

  // 关闭关键阻断后重试 g3（上游 gateway 已确认、版本前缀匹配）；g3 是最后一项，成功即自动完成批次并冻结
  train.blockers[0].resolved = true;
  r = applyGateOutcome(train, batch, 'g3', 'confirm', '甲', '10:03');
  assert.equal(r.ok, true, r.error);
  assert.equal(train.gates.find((g) => g.id === 'g3').status, 'confirmed');
  assert.equal(remainingItems(batch).length, 0);
  assert.equal(batch.status, 'completed');
  assert.equal(train.status, 'frozen');
  // 批次完成后重复触发完成为幂等 no-op
  assert.equal(completeIfDone(batch, train, '10:04'), false);
});

test('重复确认请求沿用首次结果（幂等，不重复计数）', () => {
  const train = makeTrain();
  const batch = createBatch(train, '甲');
  applyGateOutcome(train, batch, 'g2', 'confirm', '甲', '10:02');
  const attempts = batch.items[1].attempts;
  const again = applyGateOutcome(train, batch, 'g2', 'confirm', '乙', '10:05');
  assert.equal(again.duplicated, true);
  assert.equal(batch.items[1].attempts, attempts);
  assert.equal(batch.items[1].operator, '甲'); // 不覆盖首次操作者
});

test('阻断项重开使旧批次失效：未执行项释放占用，已降级仓库保留现场', () => {
  const train = makeTrain();
  const batch = createBatch(train, '甲');
  // 先让 g2 失败，再降级 g2
  applyGateOutcome(train, batch, 'g2', 'confirm', '甲', '10:01');
  applyGateOutcome(train, batch, 'g2', 'degrade', '甲', '10:02', '上游不可用');
  const gate2 = train.gates.find((g) => g.id === 'g2');
  assert.equal(gate2.degraded, true);
  assert.equal(gate2.status, 'blocked');

  invalidateBatch(batch, train, '阻断项被乙重开', '10:09');
  assert.equal(batch.status, 'invalidated');
  assert.equal(batch.items.find((i) => i.gateId === 'g1').status, 'confirmed'); // 已确认保留
  assert.equal(batch.items.find((i) => i.gateId === 'g2').status, 'degraded'); // 已降级保留
  assert.equal(batch.items.find((i) => i.gateId === 'g3').status, 'released'); // 未执行释放
  // 门禁现场不变
  assert.equal(train.gates.find((g) => g.id === 'g2').degraded, true);
  assert.equal(train.gates.find((g) => g.id === 'g3').status, 'blocked');
  assert.ok(batch.invalidatedReason.includes('阻断项'));
});

test('两人同时提交同一批次：后到者看到冲突仓库，旧数据迁移成历史批次', () => {
  const train = makeTrain();
  train.blockers[0].resolved = true; // 让确认可以成功
  const state = makeState(train);
  const batch = createBatch(train, '甲', '09:00');
  state.batches.push(batch);

  // 乙持有的旧页面快照（批次刚建立时）
  const stale = structuredClone(batch);

  // 甲先到：确认 g2（存储修订号由 storage 层 CAS 自增，此处模拟后到者持有的旧修订号）
  const r1 = applyGateOutcome(train, batch, 'g2', 'confirm', '甲', '09:01');
  assert.equal(r1.ok, true);
  const baseRevision = 5;

  // 乙后到：拿旧快照提交 g2（已被甲处理）+ g3（仍未处理，应补执行）
  const merged = mergeLateSubmission(state, stale, '乙', { gateId: 'g3', action: 'confirm' }, baseRevision, '09:02');
  assert.equal('error' in merged, false);
  // g3 补执行成功，批次完成
  assert.equal(merged.intentApplied, true);
  const g3Item = batch.items.find((i) => i.gateId === 'g3');
  assert.equal(g3Item.status, 'confirmed');
  assert.equal(g3Item.operator, '乙');
  // g2 是冲突仓库：沿用甲的先到决定
  const conflict = merged.conflicts.find((c) => c.gateId === 'g2');
  assert.ok(conflict);
  assert.equal(conflict.applied, 'confirmed');
  assert.equal(conflict.otherOperator, '甲');
  assert.equal(conflict.autoResolved, false);
  assert.equal(conflict.baseRevision, baseRevision);
  assert.equal(conflict.staleBatchId, batch.id);
  // 旧数据迁移成历史批次
  const archived = state.batches.find((b) => b.id === merged.archived.id);
  assert.ok(archived);
  assert.equal(archived.status, 'invalidated');
  assert.equal(archived.archivedFrom, batch.id);
  assert.ok(archived.note.includes('旧数据迁移'));
});

test('后到提交与先到决定一致时自动合并', () => {
  const train = makeTrain();
  train.blockers[0].resolved = true;
  const state = makeState(train);
  const batch = createBatch(train, '甲');
  state.batches.push(batch);
  const stale = structuredClone(batch);
  applyGateOutcome(train, batch, 'g2', 'confirm', '甲', '09:01');
  // 乙后到也提交 g2 确认，与甲的先到决定一致
  const merged = mergeLateSubmission(state, stale, '乙', { gateId: 'g2', action: 'confirm' }, 9, '09:02');
  const conflict = merged.conflicts.find((c) => c.gateId === 'g2');
  assert.ok(conflict);
  assert.equal(conflict.autoResolved, true);
});

test('批次失效后新请求必须重开批次，不能在旧批次上继续', () => {
  const train = makeTrain();
  const state = makeState(train);
  const batch = createBatch(train, '甲');
  state.batches.push(batch);
  invalidateBatch(batch, train, '冻结计划变更', '10:00');
  assert.equal(activeBatch(state, train.id), undefined);
  // 新批次指纹随计划变化
  train.freezeAt = '2026-10-02 08:00';
  const batch2 = createBatch(train, '乙');
  assert.notEqual(batch2.idempotencyKey, batch.idempotencyKey);
  assert.deepEqual(batch2.order.map((i) => i.gateId), ['g1', 'g2', 'g3']); // 顺序按当前计划重新固定
  // 旧批次已降级仓库在新批次中沿用为 degraded 现场
  assert.equal(batch2.items.find((i) => i.gateId === 'g1').status, 'confirmed');
});

test('v1 整页状态迁移成历史批次', () => {
  const legacy = {
    activeId: 'legacy-train',
    trains: [{
      id: 'legacy-train', name: 'Old', freezeAt: '2026-09-01 09:00', status: 'preparing',
      gates: [
        { id: 'x1', repository: 'repo-a', owner: 'o', dependency: '', version: '1.0', status: 'confirmed' },
        { id: 'x2', repository: 'repo-b', owner: 'o', dependency: '', version: '2.0', status: 'pending' }
      ],
      blockers: [],
      audit: []
    }]
  };
  const { state, migrated } = migrateLegacy(legacy);
  assert.equal(migrated, true);
  assert.equal(state.schema, 2);
  const hist = state.batches[0];
  assert.equal(hist.status, 'invalidated');
  assert.equal(hist.items[0].status, 'confirmed');
  assert.equal(hist.items[1].status, 'released');
  assert.ok(hist.note.includes('迁移'));
  assert.ok(findTrain(state, 'legacy-train'));
  // 二次加载已是 v2，不再重复迁移
  const again = migrateLegacy(state);
  assert.equal(again.migrated, false);
});

test('已冻结列车的 v1 状态迁移为已完成历史批次', () => {
  const legacy = {
    activeId: 't',
    trains: [{ id: 't', name: 'Frozen', freezeAt: 'x', status: 'frozen', gates: [], blockers: [], audit: [] }]
  };
  const { state } = migrateLegacy(legacy);
  assert.equal(state.batches[0].status, 'completed');
});

test('审计可追溯：失效、冲突、降级均有记录', () => {
  const train = makeTrain();
  addAudit(train, '基线');
  const batch = createBatch(train, '甲');
  applyGateOutcome(train, batch, 'g2', 'degrade', '甲', '10:00', '原因 X');
  invalidateBatch(batch, train, '阻断项重开', '10:10');
  const texts = train.audit.map((a) => a.text).join('\n');
  assert.ok(texts.includes('降级'));
  assert.ok(texts.includes('失效'));
  assert.ok(texts.includes('保留现场'));
});
