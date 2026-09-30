import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
}
export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
}
export interface AuditEntry {
  id: string;
  at: string;
  text: string;
}

/** 批次内单个仓库的处理状态 */
export type BatchItemStatus = 'pending' | 'done' | 'failed' | 'invalid' | 'conflict';
/** 批次整体状态 */
export type BatchStatus = 'active' | 'completed' | 'failed' | 'invalidated' | 'conflicted' | 'archived';
/** 值班员对单个仓库执行的动作 */
export type BatchAction = 'freeze' | 'downgrade' | 'confirm';

export interface BatchItem {
  gateId: string;
  repository: string;
  /** 批次开始时固定的顺序 */
  order: number;
  /** 批次开始时固定的门禁版本 */
  version: string;
  status: BatchItemStatus;
  action?: BatchAction;
  processedAt?: string;
  /** 降级现场、失败原因或冲突说明 */
  note?: string;
}

export interface FreezeBatch {
  id: string;
  trainId: string;
  /** 幂等键：重复请求沿用首次批次 */
  key: string;
  title: string;
  status: BatchStatus;
  createdAt: string;
  createdBy: string;
  /** 开始时固定的仓库顺序、门禁版本与阻断项 */
  snapshot: {
    order: string[];
    versions: Record<string, string>;
    blockers: Blocker[];
    planVersion: number;
  };
  items: BatchItem[];
  invalidatedAt?: string;
  invalidationReason?: string;
  history: AuditEntry[];
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  /** 计划版本：顺序或门禁变更时递增，旧批次据此失效 */
  planVersion: number;
  gates: RepositoryGate[];
  blockers: Blocker[];
  audit: AuditEntry[];
  batches: FreezeBatch[];
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const nowText = () => new Date().toLocaleTimeString();
const makeAudit = (text: string): AuditEntry => ({ id: `a-${newId()}`, at: nowText(), text });

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    planVersion: 1,
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }],
    batches: []
  }]
};

function snapshotTrain(train: ReleaseTrain): FreezeBatch['snapshot'] {
  return {
    order: train.gates.map((g) => g.id),
    versions: Object.fromEntries(train.gates.map((g) => [g.id, g.version])),
    blockers: train.blockers.map((b) => ({ ...b })),
    planVersion: train.planVersion
  };
}

/** 判断仓库是否被其它仍占用顺序的批次持有 */
function isGateOccupied(train: ReleaseTrain, gateId: string, excludeBatchId?: string): FreezeBatch | undefined {
  return train.batches.find((b) =>
    b.id !== excludeBatchId &&
    (b.status === 'active' || b.status === 'failed') &&
    b.items.some((it) => it.gateId === gateId && it.status !== 'invalid' && it.status !== 'conflict')
  );
}

/** 阻断项重开或计划变更时，作废旧批次未执行项并释放顺序占用，已处理项保留现场 */
function invalidateBatchesFor(train: ReleaseTrain, reason: string) {
  train.batches.forEach((b) => {
    if (b.status !== 'active' && b.status !== 'failed') return;
    b.items.forEach((it) => {
      if (it.status === 'pending' || it.status === 'failed') it.status = 'invalid';
    });
    b.status = 'invalidated';
    b.invalidatedAt = new Date().toISOString();
    b.invalidationReason = reason;
    b.history.push(makeAudit(`批次失效：${reason}；未执行确认作废并释放顺序占用，已处理仓库保留现场`));
  });
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        planVersion: 1,
        gates: [],
        blockers: [],
        audit: [makeAudit('创建发布列车')],
        batches: []
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      train.audit.unshift(makeAudit(`${gate.repository} 门禁由发布负责人确认`));
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift(makeAudit(`状态调整为 ${action.payload}`));
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift(makeAudit(`阻断项已关闭：${blocker.title}`));
    },
    reopenBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker || !blocker.resolved) return;
      blocker.resolved = false;
      invalidateBatchesFor(train, `阻断项重开：${blocker.title}`);
      train.audit.unshift(makeAudit(`阻断项重开：${blocker.title}；旧批次未执行确认失效并释放顺序占用`));
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.planVersion += 1;
      invalidateBatchesFor(train, '发布顺序变更');
      train.audit.unshift(makeAudit(`调整 ${moved.repository} 的发布顺序，计划版本升至 v${train.planVersion}；旧批次失效`));
    },
    updateGate(state, action: PayloadAction<{ gateId: string; changes: Partial<RepositoryGate> }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      Object.assign(gate, action.payload.changes);
      train.planVersion += 1;
      invalidateBatchesFor(train, '门禁计划变更');
      train.audit.unshift(makeAudit(`更新 ${gate.repository} 门禁信息，计划版本升至 v${train.planVersion}；旧批次失效`));
    },

    /** 开始冻结批次：固定顺序/版本/阻断项，检测并发占用冲突，幂等键沿用首次批次 */
    startFreezeBatch(state, action: PayloadAction<{ trainId: string; key: string; title?: string; createdBy: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      if (!train) return;
      const existing = train.batches.find((b) => b.key === action.payload.key);
      if (existing) {
        train.audit.unshift(makeAudit(`重复请求沿用首次批次「${existing.title}」（幂等键 ${action.payload.key}）`));
        return;
      }
      const snap = snapshotTrain(train);
      const items: BatchItem[] = train.gates.map((g, idx) => {
        const occupied = isGateOccupied(train, g.id);
        return {
          gateId: g.id,
          repository: g.repository,
          order: idx,
          version: g.version,
          status: occupied ? 'conflict' : 'pending',
          note: occupied ? `仓库正被批次「${occupied.title}」占用` : undefined
        };
      });
      const conflictCount = items.filter((it) => it.status === 'conflict').length;
      const batch: FreezeBatch = {
        id: `batch-${newId()}`,
        trainId: train.id,
        key: action.payload.key,
        title: action.payload.title ?? `冻结批次 ${train.batches.length + 1}`,
        status: conflictCount > 0 ? 'conflicted' : 'active',
        createdAt: new Date().toISOString(),
        createdBy: action.payload.createdBy,
        snapshot: snap,
        items,
        history: [makeAudit(conflictCount > 0
          ? `批次创建时检测到 ${conflictCount} 个仓库被并发占用，标记冲突`
          : '批次创建：固定仓库顺序、门禁版本与阻断项，开始冻结')]
      };
      train.batches.unshift(batch);
      train.audit.unshift(makeAudit(`${conflictCount > 0 ? '创建冲突批次' : '创建冻结批次'}「${batch.title}」${conflictCount > 0 ? `，${conflictCount} 个仓库冲突` : ''}`));
    },

    /** 处理批次中的单个仓库；降级时保留版本现场 */
    advanceBatchItem(state, action: PayloadAction<{ batchId: string; gateId: string; action: BatchAction; note?: string }>) {
      const train = state.trains.find((item) => item.batches.some((b) => b.id === action.payload.batchId));
      const batch = train?.batches.find((b) => b.id === action.payload.batchId);
      if (!train || !batch) return;
      if (batch.status !== 'active' && batch.status !== 'failed') return;
      const item = batch.items.find((it) => it.gateId === action.payload.gateId);
      if (!item || item.status === 'done' || item.status === 'invalid') return;
      const occupiedBy = isGateOccupied(train, item.gateId, batch.id);
      if (occupiedBy) {
        item.status = 'conflict';
        item.note = `仓库正被批次「${occupiedBy.title}」占用`;
        batch.status = 'conflicted';
        batch.history.push(makeAudit(`${item.repository} 与批次「${occupiedBy.title}」冲突，等待协调`));
        return;
      }
      const gate = train.gates.find((g) => g.id === item.gateId);
      if (action.payload.action === 'downgrade' && gate) {
        const from = gate.version;
        const to = action.payload.note?.match(/降级到\s*(\S+)/)?.[1] ?? gate.version;
        item.note = `从 ${from} 降级到 ${to}`;
        gate.version = to;
      } else {
        item.note = action.payload.note;
      }
      item.status = 'done';
      item.action = action.payload.action;
      item.processedAt = new Date().toISOString();
      if (gate && action.payload.action !== 'downgrade') gate.status = 'confirmed';
      const verb = action.payload.action === 'freeze' ? '冻结' : action.payload.action === 'downgrade' ? '降级' : '确认';
      batch.history.push(makeAudit(`${item.repository} 已${verb}${item.note ? `（${item.note}）` : ''}`));
      const unfinished = batch.items.some((it) => it.status === 'pending' || it.status === 'failed' || it.status === 'conflict');
      if (!unfinished) {
        batch.status = 'completed';
        batch.history.push(makeAudit('批次全部仓库处理完成，顺序占用释放'));
        train.audit.unshift(makeAudit(`冻结批次「${batch.title}」完成`));
      } else {
        batch.status = 'active';
      }
    },

    /** 标记批次中单个仓库处理失败，保留已处理仓库现场 */
    failBatchItem(state, action: PayloadAction<{ batchId: string; gateId: string; error: string }>) {
      const train = state.trains.find((item) => item.batches.some((b) => b.id === action.payload.batchId));
      const batch = train?.batches.find((b) => b.id === action.payload.batchId);
      if (!train || !batch) return;
      const item = batch.items.find((it) => it.gateId === action.payload.gateId);
      if (!item || item.status === 'done' || item.status === 'invalid') return;
      item.status = 'failed';
      item.note = action.payload.error;
      batch.status = 'failed';
      batch.history.push(makeAudit(`${item.repository} 处理失败：${action.payload.error}；已处理仓库保留现场，等待重试`));
    },

    /** 重试批次：只重新入队未完成项，已处理仓库保留 */
    retryBatch(state, action: PayloadAction<{ batchId: string }>) {
      const train = state.trains.find((item) => item.batches.some((b) => b.id === action.payload.batchId));
      const batch = train?.batches.find((b) => b.id === action.payload.batchId);
      if (!train || !batch) return;
      if (batch.status !== 'failed' && batch.status !== 'active' && batch.status !== 'conflicted') return;
      const retryable = batch.items.filter((it) => it.status === 'failed' || it.status === 'pending' || it.status === 'conflict');
      if (retryable.length === 0) return;
      retryable.forEach((it) => { it.status = 'pending'; it.note = undefined; });
      batch.status = 'active';
      batch.history.push(makeAudit(`重试批次：${retryable.length} 个未完成仓库重新入队，已处理仓库保留`));
    },

    /** 旧版数据迁移为历史批次 */
    migrateState(state) {
      state.trains.forEach((train) => {
        if (typeof train.planVersion !== 'number') train.planVersion = 1;
        if (!Array.isArray(train.batches)) train.batches = [];
        if (train.batches.length === 0 && train.gates.length > 0) {
          const items: BatchItem[] = train.gates.map((g, idx) => ({
            gateId: g.id,
            repository: g.repository,
            order: idx,
            version: g.version,
            status: 'done',
            action: g.status === 'confirmed' ? 'confirm' : 'freeze',
            note: '迁移自旧版准备台状态'
          }));
          train.batches.push({
            id: `batch-hist-${train.id}`,
            trainId: train.id,
            key: `historical-${train.id}`,
            title: '历史冻结批次（迁移）',
            status: 'archived',
            createdAt: new Date(0).toISOString(),
            createdBy: 'system',
            snapshot: snapshotTrain(train),
            items,
            history: [makeAudit('旧版状态迁移为历史批次，保留已处理仓库现场')]
          });
        }
      });
    },

    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  advanceBatchItem,
  confirmGate,
  createTrain,
  failBatchItem,
  migrateState,
  reopenBlocker,
  replaceState,
  resolveBlocker,
  reorderGates,
  retryBatch,
  setFreeze,
  startFreezeBatch,
  updateGate
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

const STORAGE_KEY = 'yf53-release-state';

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.dispatch(migrateState());
  let applyingRemote = false;
  store.subscribe(() => {
    if (applyingRemote) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().train));
  });

  // 跨标签页同步：另一值班员提交后，本页即时看到其批次与冲突。
  // applyingRemote 抑制回写，避免收到远端状态后又写回造成回声循环。
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    applyingRemote = true;
    store.dispatch(replaceState(JSON.parse(event.newValue) as TrainState));
    store.dispatch(migrateState());
    applyingRemote = false;
  });
}

export type RootState = ReturnType<typeof store.getState>;
