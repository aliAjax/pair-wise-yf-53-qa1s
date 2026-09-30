// 发布列车冻结批次的纯领域模型：不依赖 Redux / localStorage，便于推演与测试。

export type GateStatus = 'pending' | 'confirmed' | 'blocked';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  version: string;
  status: GateStatus;
  /** 降级后保留现场：门禁维持 blocked，仅置降级标记与原因 */
  degraded?: boolean;
  degradeReason?: string;
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

export type TrainStatus = 'preparing' | 'frozen' | 'rolled-back';

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: TrainStatus;
  gates: RepositoryGate[];
  blockers: Blocker[];
  audit: AuditEntry[];
}

/** 批次内单项状态：failed 可重试；released 表示批次失效后顺序占用被释放 */
export type BatchItemStatus = 'pending' | 'confirmed' | 'failed' | 'degraded' | 'released';

export type BatchStatus = 'active' | 'completed' | 'invalidated';

export interface BatchItem {
  gateId: string;
  repository: string;
  /** 开始批次时固定的门禁版本 */
  version: string;
  order: number;
  status: BatchItemStatus;
  attempts: number;
  operator?: string;
  lastError?: string;
  degradeReason?: string;
  updatedAt?: string;
}

export interface BatchConflict {
  id: string;
  batchId: string;
  /** 后到提交基于的旧批次实例 id（同一批次可能被多次后到提交，用于去重） */
  staleBatchId: string;
  gateId: string;
  repository: string;
  /** 后到的值班员 */
  operator: string;
  /** 先到的值班员 */
  otherOperator: string;
  attempted: BatchItemStatus | string;
  applied: BatchItemStatus;
  autoResolved: boolean;
  at: string;
  baseRevision: number;
  text: string;
}

export interface PlanSnapshot {
  gateId: string;
  repository: string;
  version: string;
}

export interface BlockerSnapshot {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
}

export interface FreezeBatch {
  id: string;
  trainId: string;
  /** 由计划指纹派生，重复的开始请求沿用同一批次 */
  idempotencyKey: string;
  fingerprint: string;
  status: BatchStatus;
  createdAt: string;
  operator: string;
  freezeAt: string;
  /** 固定的仓库顺序与门禁版本 */
  order: PlanSnapshot[];
  /** 固定的阻断项快照 */
  blockers: BlockerSnapshot[];
  items: BatchItem[];
  conflicts: BatchConflict[];
  completedAt?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
  /** 历史批次来源说明：迁移 / 旧快照归档 */
  note?: string;
  /** 归档批次指向原批次 */
  archivedFrom?: string;
}

export interface TrainState {
  schema: 2;
  activeId: string;
  trains: ReleaseTrain[];
  batches: FreezeBatch[];
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function addAudit(train: ReleaseTrain, text: string, at = stamp()): void {
  train.audit.unshift({ id: uid('a'), at, text });
}

export function findTrain(state: TrainState, trainId: string): ReleaseTrain | undefined {
  return state.trains.find((item) => item.id === trainId);
}

export function activeBatch(state: TrainState, trainId: string): FreezeBatch | undefined {
  return state.batches.find((batch) => batch.trainId === trainId && batch.status === 'active');
}

/** 计划指纹：冻结时间、仓库顺序+门禁版本、阻断项开闭状态 */
export function planFingerprint(train: ReleaseTrain): string {
  return JSON.stringify({
    freezeAt: train.freezeAt,
    order: train.gates.map((gate) => [gate.id, gate.version]),
    blockers: train.blockers.map((blocker) => [blocker.id, blocker.resolved])
  });
}

function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export function idempotencyKeyFor(trainId: string, fingerprint: string): string {
  return `freeze:${trainId}:${shortHash(fingerprint)}`;
}

// ---------------------------------------------------------------------------
// 批次生命周期
// ---------------------------------------------------------------------------

export function createBatch(train: ReleaseTrain, operator: string, at = stamp()): FreezeBatch {
  const fingerprint = planFingerprint(train);
  const items: BatchItem[] = train.gates.map((gate, index) => ({
    gateId: gate.id,
    repository: gate.repository,
    version: gate.version,
    order: index,
    status: gate.status === 'confirmed' ? 'confirmed' : gate.degraded ? 'degraded' : 'pending',
    attempts: gate.status === 'confirmed' || gate.degraded ? 1 : 0,
    degradeReason: gate.degraded ? gate.degradeReason : undefined
  }));
  return {
    id: uid('batch'),
    trainId: train.id,
    idempotencyKey: idempotencyKeyFor(train.id, fingerprint),
    fingerprint,
    status: 'active',
    createdAt: at,
    operator,
    freezeAt: train.freezeAt,
    order: train.gates.map((gate) => ({ gateId: gate.id, repository: gate.repository, version: gate.version })),
    blockers: train.blockers.map(({ id, title, severity, resolved }) => ({ id, title, severity, resolved })),
    items,
    conflicts: []
  };
}

export function remainingItems(batch: FreezeBatch): BatchItem[] {
  return batch.items.filter((item) => item.status === 'pending' || item.status === 'failed');
}

export function batchProgress(batch: FreezeBatch): { total: number; done: number; percent: number } {
  const total = batch.items.length;
  const done = batch.items.filter((item) => item.status === 'confirmed' || item.status === 'degraded').length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** 门禁确认的前置检查：blocked 门禁要求关键阻断项关闭且上游依赖已确认 */
export function evaluateGate(train: ReleaseTrain, gate: RepositoryGate): string | undefined {
  if (gate.status !== 'blocked') return undefined;
  const critical = train.blockers.find((blocker) => blocker.severity === 'critical' && !blocker.resolved);
  if (critical) return `关键阻断项未关闭：${critical.title}`;
  const at = gate.dependency.lastIndexOf('@');
  if (at > 0) {
    const depName = gate.dependency.slice(0, at);
    const depVersion = gate.dependency.slice(at + 1);
    const upstream = train.gates.find((candidate) => candidate.repository === depName);
    if (upstream) {
      if (upstream.degraded) return `上游依赖 ${depName} 已被降级保留，需现场人工确认`;
      if (upstream.status !== 'confirmed') {
        return `上游依赖 ${gate.dependency} 尚未确认（${upstream.repository} 当前 ${gateStatusLabel(upstream.status)}）`;
      }
      // 主/次版本前缀匹配，补丁版本允许差异（要求 2，实际 2.0.1 视为兼容）
      const requested = depVersion.split('.');
      const actual = upstream.version.split('.');
      const mismatch = requested.some((segment, index) => segment !== '' && actual[index] !== undefined && segment !== actual[index]);
      if (mismatch) return `上游依赖 ${depName} 版本 ${upstream.version} 与要求 ${depVersion} 不一致`;
    }
  }
  return undefined;
}

export function markItem(
  batch: FreezeBatch,
  gateId: string,
  status: BatchItemStatus,
  operator: string,
  at: string,
  extra: { lastError?: string; degradeReason?: string } = {}
): BatchItem {
  const item = batch.items.find((candidate) => candidate.gateId === gateId);
  if (!item) throw new Error(`批次中找不到仓库 ${gateId}`);
  item.status = status;
  item.attempts += 1;
  item.operator = operator;
  item.updatedAt = at;
  if (status === 'failed') item.lastError = extra.lastError;
  else delete item.lastError;
  if (status === 'degraded') item.degradeReason = extra.degradeReason;
  return item;
}

/** 批次完成判定：不存在 pending/failed 即冻结列车（降级仓库随列车冻结、保留现场） */
export function completeIfDone(batch: FreezeBatch, train: ReleaseTrain, at = stamp()): boolean {
  if (batch.status !== 'active') return false;
  if (remainingItems(batch).length > 0) return false;
  batch.status = 'completed';
  batch.completedAt = at;
  train.status = 'frozen';
  const degraded = batch.items.filter((item) => item.status === 'degraded').length;
  addAudit(
    train,
    `冻结批次 ${batch.id} 全部处理完成，列车冻结${degraded > 0 ? `（${degraded} 个仓库降级保留现场）` : ''}`,
    at
  );
  return true;
}

/**
 * 批次失效：未执行项（pending/failed）释放顺序占用；
 * 已确认 / 已降级的仓库保留现场，门禁状态不动。
 */
export function invalidateBatch(batch: FreezeBatch, train: ReleaseTrain, reason: string, at = stamp()): void {
  if (batch.status !== 'active') return;
  let released = 0;
  for (const item of batch.items) {
    if (item.status === 'pending' || item.status === 'failed') {
      item.status = 'released';
      item.updatedAt = at;
      released += 1;
    }
  }
  batch.status = 'invalidated';
  batch.invalidatedAt = at;
  batch.invalidatedReason = reason;
  addAudit(
    train,
    `${reason}：旧批次 ${batch.id} 未执行确认失效，释放 ${released} 个仓库的顺序占用；已确认/已降级仓库保留现场`,
    at
  );
}

// ---------------------------------------------------------------------------
// 并发冲突与旧快照归档
// ---------------------------------------------------------------------------

export function itemStatusLabel(status: BatchItemStatus): string {
  switch (status) {
    case 'pending':
      return '待确认';
    case 'confirmed':
      return '已确认';
    case 'failed':
      return '确认失败';
    case 'degraded':
      return '已降级·保留现场';
    case 'released':
      return '已释放占用';
  }
}

export function gateStatusLabel(status: GateStatus): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'confirmed':
      return '已确认';
    case 'blocked':
      return '门禁阻断';
  }
}

export function batchStatusLabel(status: BatchStatus): string {
  switch (status) {
    case 'active':
      return '进行中';
    case 'completed':
      return '已完成·列车冻结';
    case 'invalidated':
      return '已失效·历史批次';
  }
}

export interface LateIntent {
  gateId: string;
  action: 'confirm' | 'degrade';
  reason?: string;
}

export interface MergeResult {
  conflicts: BatchConflict[];
  archived: FreezeBatch;
  intentApplied: boolean;
  intentError?: string;
  completed: boolean;
}

/**
 * 把一次单项处理应用到批次与门禁。
 * 已处理项重复提交时直接沿用首次结果（幂等），不重复计数、不覆盖他人决定。
 */
export function applyGateOutcome(
  train: ReleaseTrain,
  batch: FreezeBatch,
  gateId: string,
  action: 'confirm' | 'degrade',
  operator: string,
  at = stamp(),
  reason?: string
): { ok: boolean; error?: string; duplicated?: boolean } {
  const gate = train.gates.find((candidate) => candidate.id === gateId);
  const item = batch.items.find((candidate) => candidate.gateId === gateId);
  if (!gate || !item) return { ok: false, error: '批次中找不到该仓库' };

  if (action === 'degrade') {
    if (item.status === 'degraded') return { ok: true, duplicated: true };
    const degradeReason = reason?.trim() || '门禁确认失败，降级保留现场';
    markItem(batch, gateId, 'degraded', operator, at, { degradeReason });
    gate.status = 'blocked';
    gate.degraded = true;
    gate.degradeReason = degradeReason;
    addAudit(train, `${gate.repository} 门禁确认失败，${operator} 决定降级并保留现场：${degradeReason}`, at);
    completeIfDone(batch, train, at);
    return { ok: true };
  }

  if (item.status === 'confirmed' || gate.status === 'confirmed') return { ok: true, duplicated: true };
  const error = evaluateGate(train, gate);
  if (error) {
    markItem(batch, gateId, 'failed', operator, at, { lastError: error });
    addAudit(train, `${gate.repository} 门禁确认失败：${error}（保留进度，可重试）`, at);
    return { ok: false, error };
  }
  markItem(batch, gateId, 'confirmed', operator, at);
  gate.status = 'confirmed';
  delete gate.degraded;
  delete gate.degradeReason;
  addAudit(train, `${gate.repository} 门禁由 ${operator} 在批次 ${batch.id} 中确认`, at);
  completeIfDone(batch, train, at);
  return { ok: true };
}

function archiveStaleBatch(state: TrainState, stale: FreezeBatch, current: FreezeBatch, lateOperator: string, at: string, baseRevision: number): FreezeBatch {
  const archived: FreezeBatch = {
    ...structuredClone(stale),
    id: uid('hist'),
    status: 'invalidated',
    archivedFrom: current.id,
    conflicts: [],
    invalidatedAt: at,
    invalidatedReason: '后到提交基于过期批次数据',
    note: `旧数据迁移：${lateOperator} 后到提交时本地批次（存储修订号 ${baseRevision}）已过期，整页快照归档为历史批次，原批次 ${current.id} 继续生效`
  };
  state.batches.unshift(archived);
  return archived;
}

/**
 * 后到提交基于过期修订号：
 * 1. 先在当前批次上尝试执行本人意图（目标仍未处理才执行；已被他人处理则登记冲突、沿用先到结果）；
 * 2. 逐条比对旧快照与当前批次，登记所有冲突仓库；
 * 3. 旧批次整页快照迁移成历史批次。
 *
 * @param baseRevision 后到者页面所基于的存储修订号
 */
export function mergeLateSubmission(
  state: TrainState,
  stale: FreezeBatch,
  lateOperator: string,
  intent: LateIntent,
  baseRevision: number,
  at = stamp()
): MergeResult | { error: string } {
  const train = findTrain(state, stale.trainId);
  // 归档批次本身不能再作为合并目标（其 id 是历史快照，不是进行中原批次）
  const current = state.batches.find((batch) => batch.id === stale.id && batch.status === 'active' && !batch.archivedFrom);
  if (!train) return { error: '发布列车已不存在' };
  if (!current) {
    const archived = archiveStaleBatch(state, stale, stale, lateOperator, at, baseRevision);
    addAudit(train, `${lateOperator} 的后到提交到达时原批次已结束，旧快照迁移为历史批次 ${archived.id}`, at);
    return {
      conflicts: [],
      archived,
      intentApplied: false,
      intentError: '原批次已失效或完成，请按当前计划重新开始批次',
      completed: false
    };
  }

  const conflicts: BatchConflict[] = [];
  const recordConflict = (
    gateId: string,
    otherOperator: string,
    attempted: string,
    applied: BatchItemStatus,
    autoResolved: boolean
  ) => {
    const liveItem = current.items.find((item) => item.gateId === gateId)!;
    // 同一旧批次实例、同一仓库只登记一次（意图仓库可能与差异扫描重叠）
    if (current.conflicts.some((candidate) => candidate.staleBatchId === stale.id && candidate.gateId === gateId)) return;
    const conflict: BatchConflict = {
      id: uid('c'),
      batchId: current.id,
      staleBatchId: stale.id,
      gateId,
      repository: liveItem.repository,
      operator: lateOperator,
      otherOperator,
      attempted,
      applied,
      autoResolved,
      at,
      baseRevision,
      text: autoResolved
        ? `${liveItem.repository}：${lateOperator} 的后到提交与 ${otherOperator} 的先到决定一致（${itemStatusLabel(applied)}），自动合并`
        : `${liveItem.repository}：${lateOperator} 后到提交（${attempted}），${otherOperator} 已先处理为「${itemStatusLabel(applied)}」，沿用先到决定`
    };
    conflicts.push(conflict);
    current.conflicts.unshift(conflict);
  };

  // 1. 执行本人意图
  let intentApplied = false;
  let intentError: string | undefined;
  const target = current.items.find((item) => item.gateId === intent.gateId);
  if (target) {
    if (target.status === 'pending' || target.status === 'failed') {
      const result = applyGateOutcome(train, current, intent.gateId, intent.action, lateOperator, at, intent.reason);
      intentApplied = result.ok;
      intentError = result.error;
    } else {
      const attemptedLabel = intent.action === 'degrade' ? itemStatusLabel('degraded') : itemStatusLabel('confirmed');
      recordConflict(intent.gateId, target.operator ?? '另一值班员', attemptedLabel, target.status, target.status === (intent.action === 'degrade' ? 'degraded' : 'confirmed'));
    }
  }

  // 2. 旧快照里其余仓库与当前批次的差异（即他人抢先处理的仓库）
  for (const staleItem of stale.items) {
    if (staleItem.gateId === intent.gateId) continue;
    const liveItem = current.items.find((item) => item.gateId === staleItem.gateId);
    if (!liveItem || liveItem.status === staleItem.status) continue;
    const otherOperator = liveItem.operator ?? '另一值班员';
    if (otherOperator === lateOperator) continue;
    recordConflict(liveItem.gateId, otherOperator, itemStatusLabel(staleItem.status), liveItem.status, false);
  }

  // 3. 归档旧快照
  const archived = archiveStaleBatch(state, stale, current, lateOperator, at, baseRevision);
  addAudit(
    train,
    `${lateOperator} 的提交基于过期状态（存储修订号 ${baseRevision}），检出 ${conflicts.length} 个冲突仓库，旧快照迁移为历史批次 ${archived.id}`,
    at
  );

  return {
    conflicts,
    archived,
    intentApplied,
    intentError,
    completed: current.status === 'completed'
  };
}

// ---------------------------------------------------------------------------
// 旧版本（v1：整页 localStorage）迁移
// ---------------------------------------------------------------------------

interface LegacyGate {
  id?: string;
  repository?: string;
  owner?: string;
  dependency?: string;
  version?: string;
  status?: GateStatus;
}
interface LegacyTrain {
  id?: string;
  name?: string;
  freezeAt?: string;
  status?: TrainStatus;
  gates?: LegacyGate[];
  blockers?: Blocker[];
  audit?: AuditEntry[];
}
interface LegacyState {
  activeId?: string;
  trains?: LegacyTrain[];
}

export function migrateLegacy(raw: unknown): { state: TrainState; migrated: boolean } {
  if (raw && typeof raw === 'object' && (raw as { schema?: number }).schema === 2) {
    return { state: raw as TrainState, migrated: false };
  }
  const legacy = (raw ?? {}) as LegacyState;
  const at = stamp();
  const trains: ReleaseTrain[] = (legacy.trains ?? []).map((train) => ({
    id: train.id ?? uid('train'),
    name: train.name ?? '未命名发布列车',
    freezeAt: train.freezeAt ?? '',
    status: train.status ?? 'preparing',
    gates: (train.gates ?? []).map((gate) => ({
      id: gate.id ?? uid('g'),
      repository: gate.repository ?? 'unknown',
      owner: gate.owner ?? '',
      dependency: gate.dependency ?? '',
      version: gate.version ?? '0.0.0',
      status: gate.status === 'confirmed' || gate.status === 'blocked' ? gate.status : 'pending'
    })),
    blockers: (train.blockers ?? []).map((blocker) => ({
      id: blocker.id,
      title: blocker.title,
      severity: blocker.severity === 'critical' ? 'critical' : 'warning',
      resolved: Boolean(blocker.resolved)
    })),
    audit: train.audit ?? []
  }));

  const batches: FreezeBatch[] = [];
  for (const train of trains) {
    const hasProgress = train.status === 'frozen' || train.gates.some((gate) => gate.status === 'confirmed');
    if (!hasProgress) continue;
    const items: BatchItem[] = train.gates.map((gate, index) => ({
      gateId: gate.id,
      repository: gate.repository,
      version: gate.version,
      order: index,
      status: gate.status === 'confirmed' ? 'confirmed' : 'released',
      attempts: gate.status === 'confirmed' ? 1 : 0
    }));
    batches.push({
      id: `hist-legacy-${train.id}`,
      trainId: train.id,
      idempotencyKey: `legacy:${train.id}`,
      fingerprint: 'legacy',
      status: train.status === 'frozen' ? 'completed' : 'invalidated',
      createdAt: '—',
      operator: '历史迁移',
      freezeAt: train.freezeAt,
      order: train.gates.map((gate) => ({ gateId: gate.id, repository: gate.repository, version: gate.version })),
      blockers: train.blockers.map(({ id, title, severity, resolved }) => ({ id, title, severity, resolved })),
      items,
      conflicts: [],
      completedAt: train.status === 'frozen' ? '—' : undefined,
      invalidatedAt: train.status === 'frozen' ? undefined : '—',
      note: '旧版本整页状态迁移：v1 控制台按整页保存、无批次记录，现有门禁决定迁移为历史批次'
    });
    addAudit(train, `检测到旧版本整页状态，已迁移为历史批次 hist-legacy-${train.id}`, at);
  }

  return {
    state: {
      schema: 2,
      activeId: legacy.activeId && trains.some((train) => train.id === legacy.activeId) ? legacy.activeId! : trains[0]?.id ?? '',
      trains,
      batches
    },
    migrated: true
  };
}
