import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  batchProgress,
  batchStatusLabel,
  changeFreezeAt,
  clearNotice,
  createTrain,
  gateStatusLabel,
  itemStatusLabel,
  reorderGates,
  reopenBlocker,
  resolveBlocker,
  retryUnresolved,
  setOperatorState,
  setTrainStatus,
  simulateConcurrentSubmit,
  startFreezeBatch,
  submitGate,
  useGetTrainHealthQuery,
  type AppDispatch,
  type FreezeBatch,
  type RepositoryGate,
  type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const itemColor: Record<string, string> = {
  confirmed: 'green',
  degraded: 'orange',
  failed: 'red',
  released: 'gray',
  pending: 'yellow'
};

function SortableGate({ gate, disabled, onConfirm, onDegrade }: { gate: RepositoryGate; disabled: boolean; onConfirm: () => void; onDegrade: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id, disabled });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>
            {gate.repository}
            {gate.degraded && <Badge ml="sm" color="orange">已降级·保留现场</Badge>}
          </Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
          {gate.degradeReason && <Text size="sm" c="orange">{gate.degradeReason}</Text>}
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gateStatusLabel(gate.status)}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={disabled || gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" color="orange" onClick={onDegrade} disabled={disabled || gate.degraded}>降级保留</Button>
          <Button size="xs" variant="subtle" disabled={disabled} {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function BatchPanel({ batch, operator, storageRevision, dispatch }: { batch: FreezeBatch; operator: string; storageRevision: number; dispatch: AppDispatch }) {
  const progress = batchProgress(batch);
  const remaining = batch.items.filter((item) => item.status === 'pending' || item.status === 'failed');
  const others = operator === '值班员甲' ? '值班员乙' : '值班员甲';
  const otherCandidate = batch.items.find((item) => item.status === 'pending' || item.status === 'failed');
  const selfCandidate = batch.items.find((item) => item.gateId !== otherCandidate?.gateId && (item.status === 'pending' || item.status === 'failed')) ?? otherCandidate;

  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Title order={3}>冻结批次 {batch.id}</Title>
        <Badge color={batch.status === 'active' ? 'blue' : batch.status === 'completed' ? 'green' : 'gray'}>{batchStatusLabel(batch.status)}</Badge>
      </Group>
      <Text size="sm" c="dimmed">
        开始于 {batch.createdAt} · 发起人 {batch.operator} · 计划冻结 {batch.freezeAt} · 当前存储修订号 {storageRevision}
      </Text>
      {batch.status === 'active' && (
        <>
          <Progress mt="sm" value={progress.percent} />
          <Text size="xs" c="dimmed" mt={4}>已处理 {progress.done}/{progress.total}（含降级保留），失败项可重试</Text>
          <Group mt="sm">
            <Button size="xs" variant="light" disabled={remaining.length === 0} onClick={() => dispatch(retryUnresolved(batch.id, operator))}>
              只重试未完成项（{remaining.length}）
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="grape"
              disabled={!otherCandidate || !selfCandidate}
              onClick={() =>
                otherCandidate &&
                selfCandidate &&
                dispatch(
                  simulateConcurrentSubmit(
                    { batchId: batch.id, otherGateId: otherCandidate.gateId, lateGateId: selfCandidate.gateId, action: 'confirm' },
                    operator
                  )
                )
              }
            >
              模拟「{others} 与我同时提交」
            </Button>
          </Group>
        </>
      )}
      {batch.invalidatedReason && <Alert mt="sm" color="orange" variant="light" title="批次已失效">{batch.invalidatedReason}（{batch.invalidatedAt}）。未执行项已释放顺序占用，可按当前计划重开批次；已确认/已降级仓库保留现场。</Alert>}
      {batch.note && <Alert mt="sm" color="gray" variant="light" title="历史批次说明">{batch.note}</Alert>}

      <SimpleGrid cols={{ base: 1, sm: 3 }} mt="md" spacing="xs">
        {batch.items.map((item) => (
          <Card key={item.gateId} padding="xs" withBorder>
            <Group justify="space-between">
              <Text size="sm" fw={700}>{item.order + 1}. {item.repository}</Text>
              <Badge size="xs" color={itemColor[item.status]}>{itemStatusLabel(item.status)}</Badge>
            </Group>
            <Text size="xs" c="dimmed">固定版本 {item.version} · 尝试 {item.attempts} 次{item.operator ? ` · ${item.operator}` : ''}</Text>
            {item.lastError && <Text size="xs" c="red">{item.lastError}</Text>}
            {item.degradeReason && <Text size="xs" c="orange">{item.degradeReason}</Text>}
          </Card>
        ))}
      </SimpleGrid>

      {batch.conflicts.length > 0 && (
        <Stack gap={6} mt="md">
          <Title order={4}>冲突仓库（{batch.conflicts.length}）</Title>
          {batch.conflicts.slice(0, 6).map((conflict) => (
            <Alert key={conflict.id} color={conflict.autoResolved ? 'teal' : 'grape'} variant="light" title={`${conflict.autoResolved ? '自动合并' : '沿用先到决定'} · ${conflict.at}`}>
              <Text size="sm">{conflict.text}</Text>
              <Text size="xs" c="dimmed">基于修订号 {conflict.baseRevision} 的旧页面提交</Text>
            </Alert>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export default function Home() {
  const dispatch: AppDispatch = useDispatch();
  const consoleState = useSelector((root: RootState) => root.console);
  const { revision, data, operator, notice } = consoleState;
  const currentTrain = data.trains.find((item) => item.id === data.activeId) ?? data.trains[0];
  const { data: health } = useGetTrainHealthQuery(currentTrain?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const [freezeInput, setFreezeInput] = useState(currentTrain?.freezeAt ?? '');

  useEffect(() => setFreezeInput(currentTrain?.freezeAt ?? ''), [currentTrain?.id, currentTrain?.freezeAt]);

  if (!currentTrain) return null;
  const unresolved = currentTrain.blockers.filter((item) => !item.resolved).length;
  const confirmed = currentTrain.gates.filter((item) => item.status === 'confirmed').length;
  const batch = data.batches.find((item) => item.trainId === currentTrain.id && item.status === 'active');
  const historyBatches = data.batches.filter((item) => item.trainId === currentTrain.id && item.status !== 'active');

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderGates(String(event.active.id), String(event.over.id), operator));
    }
  }

  function degradePrompt(gate: RepositoryGate) {
    const reason = window.prompt(`降级 ${gate.repository} 并保留现场，请记录原因：`, '上游阻断未解，先随列车冻结、保留回滚现场');
    if (reason === null) return;
    if (batch) dispatch(submitGate({ batchId: batch.id, gateId: gate.id, action: 'degrade', reason }, operator));
  }

  const snapshotMismatch = batch && batch.blockers.some((snapshot) => {
    const live = currentTrain.blockers.find((item) => item.id === snapshot.id);
    return live && live.resolved !== snapshot.resolved;
  });

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>冻结批次固定仓库顺序、门禁版本与阻断项；失败保留进度、只重试未完成项；两人并发提交按修订号合并冲突。</Text>
        </div>
        <Group>
          <SegmentedControl
            color="blue"
            data={['值班员甲', '值班员乙']}
            value={operator}
            onChange={(value) => {
              window.sessionStorage.setItem('yf53-operator', value);
              dispatch(setOperatorState(value));
            }}
          />
          <Badge size="xl" color={currentTrain.status === 'frozen' ? 'blue' : currentTrain.status === 'rolled-back' ? 'red' : 'yellow'}>{currentTrain.status}</Badge>
        </Group>
      </header>

      {notice && (
        <Alert
          mb="md"
          color={notice.kind === 'conflict' ? 'grape' : notice.kind === 'error' ? 'red' : notice.kind === 'success' ? 'green' : 'blue'}
          title={notice.title}
          withCloseButton
          onClose={() => dispatch(clearNotice())}
        >
          {notice.lines?.map((line) => <Text key={line} size="sm">{line}</Text>)}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder>
          <Text size="xs">冻结时间</Text>
          <Title order={3}>{currentTrain.freezeAt}</Title>
          <Group mt={6} gap="xs">
            <TextInput size="xs" style={{ flex: 1 }} value={freezeInput} onChange={(event) => setFreezeInput(event.currentTarget.value)} />
            <Button size="compact-xs" variant="light" onClick={() => dispatch(changeFreezeAt(freezeInput, operator))}>改计划</Button>
          </Group>
        </Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{currentTrain.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(currentTrain.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查 / 存储修订号</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title><Text size="xs" c="dimmed">revision {revision}</Text></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>跨仓库依赖门禁</Title>
              <Text size="sm" c="dimmed">{batch ? '按批次固定顺序处理，拖拽会使批次失效' : '开始冻结批次后逐项确认'}</Text>
            </Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={currentTrain.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>
                  {currentTrain.gates.map((gate) => (
                    <SortableGate
                      key={gate.id}
                      gate={gate}
                      disabled={!batch || batch.status !== 'active'}
                      onConfirm={() => batch && dispatch(submitGate({ batchId: batch.id, gateId: gate.id, action: 'confirm' }, operator))}
                      onDegrade={() => degradePrompt(gate)}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {currentTrain.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Group gap="xs">
                  <Button variant="subtle" size="xs" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
                  <Button variant="subtle" size="xs" color="orange" disabled={!item.resolved} onClick={() => dispatch(reopenBlocker(item.id, operator))}>重开（批次失效）</Button>
                </Group>
              </Group>
            ))}
          </Card>

          {batch ? (
            <BatchPanel batch={batch} operator={operator} storageRevision={revision} dispatch={dispatch} />
          ) : (
            <Alert color="blue" variant="light" title="没有进行中的冻结批次">
              在右侧「发布控制」开始批次：系统会固定当前仓库顺序、每个门禁版本与阻断项开闭快照。重复开始请求沿用同一批次。
              {historyBatches.length > 0 && <Text size="sm" mt={6}>下方保留 {historyBatches.length} 个历史批次（含旧数据迁移与冲突归档）。</Text>}
            </Alert>
          )}

          {historyBatches.length > 0 && (
            <Card withBorder>
              <Title order={3} mb="sm">历史批次（{historyBatches.length}）</Title>
              <Stack gap="sm">
                {historyBatches.slice(0, 5).map((item) => (
                  <Card key={item.id} padding="xs" withBorder>
                    <Group justify="space-between">
                      <Text size="sm" fw={700}>{item.id} <Badge ml={6} size="xs" color={item.status === 'completed' ? 'green' : 'gray'}>{batchStatusLabel(item.status)}</Badge></Text>
                      <Text size="xs" c="dimmed">{item.createdAt} · {item.operator}{item.archivedFrom ? ` · 归档自 ${item.archivedFrom}` : ''}</Text>
                    </Group>
                    {(item.note || item.invalidatedReason) && <Text size="xs" c="dimmed" mt={4}>{item.note ?? item.invalidatedReason}</Text>}
                  </Card>
                ))}
              </Stack>
            </Card>
          )}
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">开始批次后逐项确认；确认失败可重试未完成项或降级保留。门禁未全部确认时手动冻结会释放未执行项占用，降级仓库保留现场。</Text>
            <Stack gap="xs">
              <Button onClick={() => dispatch(startFreezeBatch(operator))} disabled={Boolean(batch)}>{batch ? '批次进行中…' : '开始冻结批次（固定顺序/版本/阻断项）'}</Button>
              <Group grow>
                <Button color="blue" variant="light" onClick={() => dispatch(setTrainStatus('frozen', operator))}>确认冻结</Button>
                <Button color="red" variant="light" onClick={() => dispatch(setTrainStatus('rolled-back', operator))}>标记回滚</Button>
              </Group>
              <Button variant="default" onClick={() => dispatch(setTrainStatus('preparing', operator))}>回到准备</Button>
            </Stack>
            {snapshotMismatch && <Alert mt="sm" color="orange" variant="light" title="阻断项快照已漂移">有阻断项在批次开始后被重开，当前批次已自动失效并释放未执行项占用。</Alert>}
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form
              onSubmit={form.handleSubmit((values) => {
                dispatch(createTrain(values));
                form.reset();
              })}
            >
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{currentTrain.audit.slice(0, 10).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {data.trains.map((item) => (
              <Button key={item.id} fullWidth variant={item.id === currentTrain.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>
            ))}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
