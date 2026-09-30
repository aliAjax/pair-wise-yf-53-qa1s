// 存储层冒烟：CAS 修订号、冲突拒绝、强制合并写入、v1 整页数据迁移。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('/workspace/node_modules/esbuild/lib/main.js');

// 最小 localStorage + window mock，必须在加载存储模块前就位
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map)
  };
}
const listeners = [];
globalThis.window = {
  localStorage: makeStorage(),
  addEventListener: (_type, fn) => listeners.push(fn),
  removeEventListener: () => {}
};

function bundle() {
  const result = esbuild.buildSync({
    entryPoints: ['/workspace/app/store/storage.ts'],
    write: false,
    format: 'esm',
    bundle: true,
    loader: { '.ts': 'ts' }
  });
  const out = `/tmp/storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

test('首次加载无数据时给出默认状态且不写脏修订号', async () => {
  const storage = await bundle();
  const { state, revision } = storage.loadState();
  assert.equal(state.schema, 2);
  assert.equal(revision, 0);
  assert.equal(state.trains[0].id, 'train-101');
});

test('CAS：匹配修订号才写入并自增；过期修订号被拒绝', async () => {
  const storage = await bundle();
  const { revision: rev0 } = storage.loadState();
  const r1 = storage.commit(rev0, (draft) => { draft.activeId = 'x'; }, (base, recipe) => {
    const copy = structuredClone(base); recipe(copy); return copy;
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.revision, 1);
  assert.equal(r1.state.activeId, 'x');

  // 另一客户端拿旧修订号 0 提交 -> 拒绝
  const r2 = storage.commit(0, (draft) => { draft.activeId = 'stale'; }, (base, recipe) => {
    const copy = structuredClone(base); recipe(copy); return copy;
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, storage.REVISION_MISMATCH);
  assert.equal(r2.current.state.activeId, 'x'); // 返回最新状态供合并

  // 拿最新修订号 1 提交 -> 成功
  const r3 = storage.commit(1, (draft) => { draft.activeId = 'y'; }, (base, recipe) => {
    const copy = structuredClone(base); recipe(copy); return copy;
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.revision, 2);
});

test('冲突合并后 forceWrite 单调推进修订号', async () => {
  const storage = await bundle();
  const { state } = storage.loadState();
  const snapshot = storage.forceWrite({ ...state, activeId: 'merged' }, 99);
  assert.equal(snapshot.revision, 100);
  assert.equal(storage.loadState().revision, 100);
  assert.equal(storage.loadState().state.activeId, 'merged');
});

test('v1 整页状态首次加载即迁移为 schema 2，并落盘避免重复迁移', async () => {
  // 直接写入一份 v1 结构的 localStorage
  const legacy = {
    activeId: 'old',
    trains: [{
      id: 'old', name: 'Old train', freezeAt: '2026-09-01', status: 'preparing',
      gates: [{ id: 'g1', repository: 'r', owner: 'o', dependency: '', version: '1', status: 'confirmed' }],
      blockers: [], audit: []
    }]
  };
  globalThis.window.localStorage.setItem('yf53-release-state', JSON.stringify(legacy));
  globalThis.window.localStorage.setItem('yf53-release-revision', '7');
  const storage = await bundle();
  const { state, revision } = storage.loadState();
  assert.equal(state.schema, 2);
  assert.equal(revision, 7);
  assert.equal(state.batches[0].id, 'hist-legacy-old');
  assert.equal(state.batches[0].status, 'invalidated');
  // 落盘的已经是 v2，重新加载不再产生重复历史批次
  const again = storage.loadState();
  assert.equal(again.state.batches.filter((b) => b.id === 'hist-legacy-old').length, 1);
});

test('跨标签页 storage 事件触发外部订阅回调', async () => {
  const storage = await bundle();
  const events = [];
  const stop = storage.subscribeExternal((snapshot) => events.push(snapshot.revision));
  const { revision } = storage.loadState();
  storage.commit(revision, (draft) => { draft.activeId = 'tab1'; }, (base, recipe) => {
    const copy = structuredClone(base); recipe(copy); return copy;
  });
  // 模拟另一标签页写入后浏览器派发 storage 事件
  listeners.slice().forEach((fn) => fn({ key: 'yf53-release-state' }));
  assert.ok(events.length >= 1);
  stop();
});
