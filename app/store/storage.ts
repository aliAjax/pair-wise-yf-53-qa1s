// 持久化层：单调修订号 + 比较并交换（CAS）写入 + 跨标签页 storage 事件同步。
// 旧实现"订阅即整页覆盖"会让两个值班员后保存的整页状态盖掉对方的决定；
// 现在所有写操作都必须基于已读到的最新修订号提交。

import { migrateLegacy, type TrainState } from './freeze';

const STORAGE_KEY = 'yf53-release-state';
const REV_KEY = 'yf53-release-revision';

export const REVISION_MISMATCH = 'REVISION_MISMATCH';

export interface StorageSnapshot {
  state: TrainState;
  revision: number;
}

let memoryState: TrainState | null = null;
let memoryRevision = 0;

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

/** 读取当前权威状态：localStorage 为权威源，SSR / 私密模式下退化为内存态。 */
export function loadState(): StorageSnapshot {
  if (memoryState) return { state: memoryState, revision: memoryRevision };
  if (!hasStorage()) {
    return { state: defaultState(), revision: 0 };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const revRaw = window.localStorage.getItem(REV_KEY);
  const revision = Number.parseInt(revRaw ?? '0', 10) || 0;
  if (!raw) {
    const state = defaultState();
    memoryState = state;
    return { state, revision: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const state = defaultState();
    memoryState = state;
    return { state, revision: 0 };
  }
  const { state } = migrateLegacy(parsed);
  memoryState = state;
  memoryRevision = revision;
  if ((parsed as { schema?: number } | null)?.schema !== 2) {
    // v1 整页数据刚迁移完，立即以 schema v2 落盘，避免重复迁移
    persist(state, revision);
  }
  return { state, revision };
}

function persist(state: TrainState, revision: number): void {
  memoryState = state;
  memoryRevision = revision;
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem(REV_KEY, String(revision));
  }
}

export type CommitResult =
  | { ok: true; state: TrainState; revision: number }
  | { ok: false; reason: typeof REVISION_MISMATCH; current: StorageSnapshot };

/**
 * CAS 提交：mutator 在最新状态上产生新状态。
 * expectedRevision 与当前修订号不一致时拒绝写入，调用方拿到最新状态做冲突合并。
 */
export function commit(
  expectedRevision: number,
  mutator: (draft: TrainState) => void,
  produce: (base: TrainState, recipe: (draft: TrainState) => void) => TrainState
): CommitResult {
  const { state: latest, revision } = loadState();
  if (expectedRevision !== revision) {
    return { ok: false, reason: REVISION_MISMATCH, current: { state: latest, revision } };
  }
  const next = produce(latest, mutator);
  persist(next, revision + 1);
  return { ok: true, state: next, revision: revision + 1 };
}

/** 冲突合并完成后的强制写入（修订号仍单调递增） */
export function forceWrite(state: TrainState, baseRevision: number): StorageSnapshot {
  const { revision: currentRevision } = loadState();
  const revision = Math.max(currentRevision, baseRevision) + 1;
  persist(state, revision);
  return { state, revision };
}

/** 跨标签页：另一标签页写入后，本标签页同步权威状态 */
export function subscribeExternal(handler: (snapshot: StorageSnapshot) => void): () => void {
  if (!hasStorage()) return () => undefined;
  const listener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== REV_KEY) return;
    memoryState = null; // 强制下次从 localStorage 重读
    const snapshot = loadState();
    handler(snapshot);
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

// ---------------------------------------------------------------------------
// 默认状态（仅在完全没有持久化数据时使用，沿用原控制台的演示数据）
// ---------------------------------------------------------------------------

function defaultState(): TrainState {
  return {
    schema: 2,
    activeId: 'train-101',
    trains: [
      {
        id: 'train-101',
        name: 'Sept 2026 发布列车',
        freezeAt: '2026-09-30 18:00',
        status: 'preparing',
        gates: [
          { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
          { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
          { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
        ],
        blockers: [
          { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
          { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
        ],
        audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
      }
    ],
    batches: []
  };
}
