import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { produce } from 'immer';
import {
  activeBatch,
  addAudit,
  applyGateOutcome,
  createBatch,
  findTrain,
  idempotencyKeyFor,
  invalidateBatch,
  markItem,
  mergeLateSubmission,
  planFingerprint,
  remainingItems,
  stamp,
  uid,
  type FreezeBatch,
  type ReleaseTrain,
  type TrainState
} from './freeze';
import { commit, forceWrite, loadState, subscribeExternal, type StorageSnapshot } from './storage';

export * from './freeze';

// ---------------------------------------------------------------------------
// UI 状态
// ---------------------------------------------------------------------------

export type NoticeKind = 'conflict' | 'info' | 'error' | 'success';
export interface UiNotice {
  id: string;
  kind: NoticeKind;
  title: string;
  lines?: string[];
}

interface ConsoleState {
  revision: number;
  data: TrainState;
  operator: string;
  notice: UiNotice | null;
}

const OPERATOR_KEY = 'yf53-operator';

function readOperator(): string {
  try {
    if (typeof window !== 'undefined') {
      return window.sessionStorage.getItem(OPERATOR_KEY) || '值班员甲';
    }
  } catch {
    /* ignore */
  }
  return '值班员甲';
}

const initialSnapshot: StorageSnapshot = loadState();

const consoleSlice = createSlice({
  name: 'console',
  initialState: {
    revision: initialSnapshot.revision,
    data: initialSnapshot.state,
    operator: readOperator(),
    notice: null
  } as ConsoleState,
  reducers: {
    hydrate(state, action: PayloadAction<StorageSnapshot>) {
      state.data = action.payload.state;
      state.revision = action.payload.revision;
    },
    setOperatorState(state, action: PayloadAction<string>) {
      state.operator = action.payload;
    },
    pushNotice(state, action: PayloadAction<Omit<UiNotice, 'id'>>) {
      state.notice = { ...action.payload, id: uid('n') };
    },
    clearNotice(state) {
      state.notice = null;
    }
  }
});

export const { hydrate, pushNotice, clearNotice, setOperatorState } = consoleSlice.actions;

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

export const store = configureStore({
  reducer: { console: consoleSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 统一 CAS 写入；修订号冲突时交给 onConflict 用最新状态合并 */
function transact(
  dispatch: AppDispatch,
  getState: () => RootState,
  recipe: (draft: TrainState) => void,
  onConflict?: (latest: TrainState, latestRevision: number) => { recipe?: (draft: TrainState) => void; notice?: Omit<UiNotice, 'id'> } | void
): boolean {
  const expected = getState().console.revision;
  const result = commit(expected, recipe, produce);
  if (result.ok) {
    dispatch(hydrate({ state: result.state, revision: result.revision }));
    return true;
  }
  const resolution = onConflict?.(result.current.state, result.current.revision);
  // 先用权威最新状态对齐本标签页，再决定是否补写
  dispatch(hydrate(result.current));
  if (!resolution?.recipe) return false;
  const merged = produce(result.current.state, resolution.recipe);
  const snapshot = forceWrite(merged, result.current.revision);
  dispatch(hydrate(snapshot));
  if (resolution.notice) dispatch(pushNotice(resolution.notice));
  return true;
}

// ---------------------------------------------------------------------------
// 用例 thunks
// ---------------------------------------------------------------------------

type AppThunk = (dispatch: AppDispatch, getState: () => RootState) => void;

/** 开始冻结批次：固定仓库顺序、门禁版本与阻断项；重复请求沿用首次批次 */
export function startFreezeBatch(operator: string): AppThunk {
  return (dispatch, getState) => {
    const resultBox: { outcome: 'created' | 'reused' | 'blocked'; reusedId?: string } = { outcome: 'blocked' };
    const ok = transact(
      dispatch,
      getState,
      (draft) => {
        const train = findTrain(draft, draft.activeId);
        if (!train) return;
        const key = idempotencyKeyFor(train.id, planFingerprint(train));
        const existing = activeBatch(draft, train.id);
        if (existing && existing.idempotencyKey === key) {
          resultBox.outcome = 'reused';
          resultBox.reusedId = existing.id;
          addAudit(train, `${operator} 重复发起冻结请求，沿用首次批次 ${existing.id}（顺序/版本/阻断项快照不变）`);
          return;
        }
        if (existing) {
          resultBox.outcome = 'blocked';
          return;
        }
        const batch = createBatch(train, operator);
        draft.batches.unshift(batch);
        resultBox.outcome = 'created';
        train.status = 'preparing';
        addAudit(
          train,
          `${operator} 开始冻结批次 ${batch.id}：固定 ${batch.order.length} 个仓库的分批顺序与门禁版本、${batch.blockers.length} 个阻断项快照`,
          batch.createdAt
        );
      },
      () => ({
        notice: {
          kind: 'conflict',
          title: '开始批次遇到并发修改',
          lines: ['另一值班员刚刚改动了列车状态，本页已对齐最新修订号，请确认计划后重新开始批次。']
        }
      })
    );
    if (!ok) return;
    if (resultBox.outcome === 'reused') {
      dispatch(
        pushNotice({
          kind: 'info',
          title: '重复请求，沿用首次冻结批次',
          lines: [`批次 ${resultBox.reusedId} 已在相同计划（顺序/版本/阻断项）上开始，本次请求直接复用，不另开批次。`]
        })
      );
      return;
    }
    if (resultBox.outcome === 'created') {
      const batch = activeBatch(getState().console.data, getState().console.data.activeId);
      dispatch(
        pushNotice({
          kind: 'success',
          title: `冻结批次 ${batch?.id ?? ''} 已开始`,
          lines: [
            `值班员：${operator}`,
            `已固定 ${batch?.order.length ?? 0} 个仓库的顺序与门禁版本，阻断项快照 ${batch?.blockers.length ?? 0} 条。`,
            '确认失败会保留已处理仓库，可只重试未完成项。'
          ]
        })
      );
    }
  };
}

export interface GateSubmitInput {
  batchId: string;
  gateId: string;
  action: 'confirm' | 'degrade';
  reason?: string;
}

/** 提交单个仓库的门禁决定（确认 / 降级保留）；并发后到走冲突合并 */
export function submitGate(input: GateSubmitInput, operator: string = readOperator()): AppThunk {
  return (dispatch, getState) => {
    const expected = getState().console.revision;
    const staleBatch = getState().console.data.batches.find((batch) => batch.id === input.batchId);
    const stale = staleBatch ? (structuredClone(staleBatch) as FreezeBatch) : undefined;

    const result = commit(
      expected,
      (draft) => {
        const batch = draft.batches.find((item) => item.id === input.batchId);
        const train = draft.trains.find((item) => item.id === batch?.trainId);
        if (!batch || !train || batch.status !== 'active') return;
        applyGateOutcome(train, batch, input.gateId, input.action, operator, stamp(), input.reason);
      },
      produce
    );

    if (result.ok) {
      dispatch(hydrate({ state: result.state, revision: result.revision }));
      const batch = result.state.batches.find((item) => item.id === input.batchId);
      const gate = batch?.items.find((item) => item.gateId === input.gateId);
      if (batch?.status === 'completed') {
        dispatch(pushNotice({ kind: 'success', title: '批次完成，列车已冻结', lines: [`批次 ${batch.id} 全部仓库处理完毕（含降级保留）。`] }));
      } else if (input.action === 'confirm' && gate?.status === 'failed') {
        dispatch(pushNotice({ kind: 'error', title: `${gate.repository} 门禁确认失败`, lines: [gate.lastError ?? '门禁条件不满足', '进度已保留，解除阻断后可只重试未完成项。'] }));
      }
      return;
    }

    // 修订号冲突：先对齐权威状态，再把后到意图合并进当前批次，旧快照归档
    dispatch(hydrate(result.current));
    if (!stale) return;
    let mergeInfo: ReturnType<typeof mergeLateSubmission> | undefined;
    const merged = produce(result.current.state, (draft) => {
      mergeInfo = mergeLateSubmission(draft, stale, operator, { gateId: input.gateId, action: input.action, reason: input.reason }, expected);
    });
    if (mergeInfo && 'error' in mergeInfo) {
      dispatch(pushNotice({ kind: 'error', title: '提交未被接受', lines: [mergeInfo.error] }));
      return;
    }
    const info = mergeInfo;
    const snapshot = forceWrite(merged, result.current.revision);
    dispatch(hydrate(snapshot));
    if (!info) return;
    const hard = info.conflicts.filter((c) => !c.autoResolved);
    dispatch(
      pushNotice({
        kind: 'conflict',
        title: `后到提交：${hard.length} 个冲突仓库${info.intentApplied ? '，你的决定已补执行' : info.intentError ? '，目标仓库已被先处理' : ''}`,
        lines: info.conflicts
          .map((c) => `• ${c.text}`)
          .concat([
            info.intentError ? `你提交的仓库：${info.intentError}` : '',
            `旧批次（存储修订号 ${expected}）整页快照已迁移为历史批次 ${info.archived.id}，批次继续沿用先到决定。`
          ])
          .filter(Boolean)
      })
    );
  };
}

/** 只重试未完成项（pending/failed），已确认/已降级仓库保持不动，按固定顺序推进 */
export function retryUnresolved(batchId: string, operator: string): AppThunk {
  return (dispatch, getState) => {
    const recipe = (draft: TrainState) => {
      const batch = draft.batches.find((item) => item.id === batchId);
      const train = draft.trains.find((item) => item.id === batch?.trainId);
      if (!batch || !train || batch.status !== 'active') return;
      const targets = remainingItems(batch)
        .slice()
        .sort((a, b) => a.order - b.order);
      if (targets.length === 0) return;
      addAudit(train, `${operator} 重试批次 ${batch.id} 的 ${targets.length} 个未完成仓库（已处理仓库保持现场）`);
      for (const target of targets) {
        applyGateOutcome(train, batch, target.gateId, 'confirm', operator);
      }
    };
    transact(dispatch, getState, recipe, () => ({
      notice: { kind: 'conflict', title: '重试期间计划被他人改动', lines: ['本页已对齐最新批次，请查看冲突提示后再重试未完成项。'] }
    }));
  };
}

/** 关闭阻断项不影响进行中批次（关闭是解除限制，重开才会失效） */
export function resolveBlocker(blockerId: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const train = findTrain(draft, draft.activeId);
      const blocker = train?.blockers.find((item) => item.id === blockerId);
      if (!train || !blocker) return;
      blocker.resolved = true;
      addAudit(train, `阻断项已关闭：${blocker.title}`);
    });
  };
}

/** 阻断项重开：旧批次未执行确认失效并释放顺序占用，已降级仓库保留现场 */
export function reopenBlocker(blockerId: string, operator: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const train = findTrain(draft, draft.activeId);
      const blocker = train?.blockers.find((item) => item.id === blockerId);
      if (!train || !blocker) return;
      blocker.resolved = false;
      addAudit(train, `${operator} 重开阻断项：${blocker.title}`);
      const batch = activeBatch(draft, train.id);
      if (batch) invalidateBatch(batch, train, `阻断项「${blocker.title}」被 ${operator} 重开`);
    });
  };
}

/** 冻结计划变更：进行中批次失效 */
export function changeFreezeAt(freezeAt: string, operator: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const train = findTrain(draft, draft.activeId);
      if (!train || train.freezeAt === freezeAt) return;
      train.freezeAt = freezeAt;
      addAudit(train, `${operator} 调整冻结计划：冻结时间变更为 ${freezeAt}`);
      const batch = activeBatch(draft, train.id);
      if (batch) invalidateBatch(batch, train, `冻结计划变更（冻结时间调整为 ${freezeAt}）`);
    });
  };
}

/** 调整仓库顺序：批次固定顺序被打破，进行中批次失效、释放占用 */
export function reorderGates(activeId: string, overId: string, operator: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const train = findTrain(draft, draft.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === activeId);
      const to = train.gates.findIndex((item) => item.id === overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      addAudit(train, `${operator} 调整 ${moved.repository} 的发布顺序`);
      const batch = activeBatch(draft, train.id);
      if (batch) invalidateBatch(batch, train, `仓库分批顺序被 ${operator} 调整`);
    });
  };
}

/** 发布控制：回滚 / 回到准备都会使进行中批次失效；已降级仓库保留现场 */
export function setTrainStatus(status: ReleaseTrain['status'], operator: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const train = findTrain(draft, draft.activeId);
      if (!train) return;
      const batch = activeBatch(draft, train.id);
      if (status === 'frozen') {
        if (batch) {
          // 手动强制冻结：未执行项释放占用，已确认/已降级保留
          for (const item of remainingItems(batch)) markItem(batch, item.gateId, 'released', operator, stamp());
          batch.status = 'completed';
          batch.completedAt = stamp();
          batch.invalidatedReason = '手动强制冻结';
        }
        train.status = 'frozen';
        addAudit(train, `${operator} 手动确认冻结列车${batch ? `（批次 ${batch.id} 未完成项释放占用，降级仓库保留现场）` : ''}`);
        return;
      }
      train.status = status;
      addAudit(train, `${operator} 将列车状态调整为 ${status}`);
      if (batch) invalidateBatch(batch, train, status === 'rolled-back' ? `列车被 ${operator} 标记回滚` : `列车被 ${operator} 切回准备状态`);
    });
  };
}

export function createTrain(payload: { name: string; freezeAt: string }): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      const id = uid('train');
      draft.trains.push({
        id,
        name: payload.name,
        freezeAt: payload.freezeAt,
        status: 'preparing',
        gates: [],
        blockers: [],
        audit: [{ id: uid('a'), at: stamp(), text: '创建发布列车' }]
      });
      draft.activeId = id;
    });
  };
}

export function activateTrain(trainId: string): AppThunk {
  return (dispatch, getState) => {
    transact(dispatch, getState, (draft) => {
      draft.activeId = trainId;
    });
  };
}

/**
 * 单标签页内复现"两人前后脚提交同一批次"：
 * 以另一值班员身份先处理一个仓库推进修订号，再让当前值班员拿旧快照后到提交。
 */
export function simulateConcurrentSubmit(
  input: { batchId: string; otherGateId: string; lateGateId: string; action: 'confirm' | 'degrade'; reason?: string },
  operator: string
): AppThunk {
  return (dispatch, getState) => {
    const state = getState().console.data;
    const batch = state.batches.find((item) => item.id === input.batchId);
    if (!batch || batch.status !== 'active') {
      dispatch(pushNotice({ kind: 'error', title: '没有进行中的批次', lines: ['请先开始冻结批次再演练并发提交。'] }));
      return;
    }
    const otherOperator = operator === '值班员甲' ? '值班员乙' : '值班员甲';
    const baseRevision = getState().console.revision;
    transact(dispatch, getState, (draft) => {
      const live = draft.batches.find((item) => item.id === input.batchId)!;
      const train = draft.trains.find((item) => item.id === live.trainId)!;
      const stale = structuredClone(live) as FreezeBatch;
      // 另一值班员抢先处理一个仓库（真实跨标签提交会推进存储修订号）
      applyGateOutcome(train, live, input.otherGateId, 'confirm', otherOperator);
      // 当前值班员拿旧批次后到提交（mergeLateSubmission 登记冲突、归档旧快照）
      const merged = mergeLateSubmission(draft, stale, operator, { gateId: input.lateGateId, action: input.action, reason: input.reason }, baseRevision);
      if ('error' in merged) return;
      const auto = merged.conflicts.filter((c) => c.autoResolved).length;
      const hard = merged.conflicts.length - auto;
      addAudit(train, `并发演练完成：${hard} 个冲突仓库沿用先到决定${auto > 0 ? `，${auto} 个自动合并` : ''}，旧快照归档为 ${merged.archived.id}`);
    });
    const after = getState().console.data.batches.find((item) => item.id === input.batchId);
    const conflicts = after?.conflicts.slice(0, 4) ?? [];
    dispatch(
      pushNotice({
        kind: 'conflict',
        title: `两人同时提交批次 ${batch.id}：后到者视角`,
        lines: conflicts
          .map((c) => `• ${c.text}`)
          .concat([`你（${operator}）基于存储修订号 ${baseRevision} 的旧页面提交，旧数据已迁移为历史批次。`])
      })
    );
  };
}

// ---------------------------------------------------------------------------
// 跨标签页同步：其他标签页 CAS 写入后，本标签页对齐权威状态（非整页覆盖）
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  subscribeExternal((snapshot) => {
    const current = store.getState().console;
    if (snapshot.revision > current.revision) {
      store.dispatch(hydrate(snapshot));
      store.dispatch(
        pushNotice({
          kind: 'info',
          title: '另一标签页（值班员）已更新列车状态',
          lines: [`状态已同步到修订号 ${snapshot.revision}，本页不会再用旧整页状态覆盖对方决定。`]
        })
      );
    }
  });
}
