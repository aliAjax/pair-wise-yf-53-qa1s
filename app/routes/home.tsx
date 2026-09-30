import { useEffect, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  advanceBatchItem,
  confirmGate,
  createTrain,
  failBatchItem,
  reorderGates,
  resolveBlocker,
  reopenBlocker,
  retryBatch,
  setFreeze,
  startFreezeBatch,
  useGetTrainHealthQuery,
  type BatchAction,
  type BatchItem,
  type BatchStatus,
  type FreezeBatch,
  type RepositoryGate,
  type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const BATCH_STATUS_META: Record<BatchStatus, { color: string; label: string }> = {
  active: { color: 'blue', label: '进行中' },
  completed: { color: 'green', label: '已完成' },
  failed: { color: 'red', label: '失败待重试' },
  invalidated: { color: 'orange', label: '已失效' },
  conflicted: { color: 'red', label: '冲突' },
  archived: { color: 'gray', label: '历史' }
};

const ITEM_STATUS_META: Record<BatchItem['status'], { color: string; label: string }> = {
  pending: { color: 'yellow', label: '待处理' },
  done: { color: 'green', label: '已完成' },
  failed: { color: 'red', label: '失败' },
  invalid: { color: 'gray', label: '已作废' },
  conflict: { color: 'red', label: '冲突' }
};

function SortableGate({ gate, onConfirm }: { gate: RepositoryGate; onConfirm: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function BatchCard({ batch, onAdvance, onFail, onRetry }: {
  batch: FreezeBatch;
  onAdvance: (batchId: string, gateId: string, action: BatchAction, toVersion?: string) => void;
  onFail: (batchId: string, gateId: string) => void;
  onRetry: (batchId: string) => void;
}) {
  const meta = BATCH_STATUS_META[batch.status];
  const conflictRepos = batch.items.filter((it) => it.status === 'conflict').map((it) => it.repository);
  const canRetry = (batch.status === 'failed' || batch.status === 'active' || batch.status === 'conflicted') &&
    batch.items.some((it) => it.status === 'failed' || it.status === 'pending' || it.status === 'conflict');
  return (
    <Card withBorder p="sm">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700} size="sm">{batch.title}</Text>
          <Text size="xs" c="dimmed">
            {batch.createdBy} · {batch.createdAt ? new Date(batch.createdAt).toLocaleString() : ''} · 键 {batch.key}
          </Text>
        </div>
        <Badge color={meta.color}>{meta.label}</Badge>
      </Group>
      <Text size="xs" c="dimmed" mt="xs">
        快照 v{batch.snapshot.planVersion} · {batch.snapshot.order.length} 仓库 · {batch.snapshot.blockers.length} 阻断项
      </Text>
      {conflictRepos.length > 0 && (
        <Text size="xs" c="red" mt="xs">冲突仓库：{conflictRepos.join('、')}（后到者所见，需协调后重试）</Text>
      )}
      {batch.status === 'invalidated' && (
        <Text size="xs" c="orange" mt="xs">失效原因：{batch.invalidationReason}；未执行项已作废并释放顺序占用</Text>
      )}
      {batch.status === 'archived' && (
        <Text size="xs" c="dimmed" mt="xs">历史批次，已处理仓库保留现场</Text>
      )}
      <Stack gap={4} mt="xs">
        {batch.items.map((item) => {
          const im = ITEM_STATUS_META[item.status];
          const actionable = (batch.status === 'active' || batch.status === 'failed') &&
            item.status !== 'done' && item.status !== 'invalid' && item.status !== 'conflict';
          return (
            <Group key={item.gateId} justify="space-between" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text size="xs">{item.order + 1}. {item.repository} <Text span c="dimmed">v{item.version}</Text></Text>
                {item.note && <Text size="xs" c="dimmed">{item.note}</Text>}
              </div>
              <Group gap={4} wrap="nowrap">
                <Badge size="xs" color={im.color}>{im.label}{item.action ? `·${item.action}` : ''}</Badge>
                {actionable && (
                  <>
                    <Button size="xs" variant="filled" onClick={() => onAdvance(batch.id, item.gateId, 'freeze')}>冻结</Button>
                    <Button size="xs" variant="light" onClick={() => onAdvance(batch.id, item.gateId, 'confirm')}>确认</Button>
                    <Button size="xs" variant="outline" onClick={() => {
                      const to = window.prompt(`将 ${item.repository} 降级到版本`, item.version);
                      if (to) onAdvance(batch.id, item.gateId, 'downgrade', to);
                    }}>降级</Button>
                    <Button size="xs" variant="subtle" color="red" onClick={() => onFail(batch.id, item.gateId)}>模拟失败</Button>
                  </>
                )}
              </Group>
            </Group>
          );
        })}
      </Stack>
      {canRetry && <Button size="xs" mt="xs" fullWidth onClick={() => onRetry(batch.id)}>重试未完成项（保留已处理仓库）</Button>}
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;

  const [batchKey, setBatchKey] = useState(`freeze-${train?.id ?? ''}`);
  const [operator, setOperator] = useState('值班员');
  useEffect(() => { setBatchKey(`freeze-${train?.id ?? ''}`); }, [train?.id]);

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  function handleAdvance(batchId: string, gateId: string, action: BatchAction, toVersion?: string) {
    const note = action === 'downgrade' ? `降级到 ${toVersion ?? ''}` : undefined;
    dispatch(advanceBatchItem({ batchId, gateId, action, note }));
  }

  function startBatch() {
    if (!train) return;
    dispatch(startFreezeBatch({
      trainId: train.id,
      key: batchKey.trim() || `freeze-${train.id}`,
      createdBy: operator.trim() || '值班员'
    }));
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。冻结批次固定顺序、版本与阻断项，失败可续跑，重复请求沿用首次批次。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序（计划变更将作废旧批次）</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} onConfirm={() => dispatch(confirmGate(gate.id))} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div>
                <Group gap={4}>
                  <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
                  <Button variant="subtle" color="orange" disabled={!item.resolved} onClick={() => dispatch(reopenBlocker(item.id))}>重开</Button>
                </Group>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">冻结批次</Title>
            <Text size="sm" c="dimmed" mb="md">开始时固定仓库顺序、门禁版本与阻断项；失败保留已处理仓库，只重试未完成项；重复请求沿用首次批次。</Text>
            <Stack gap="xs" mb="md">
              <TextInput label="批次幂等键" value={batchKey} onChange={(e) => setBatchKey(e.currentTarget.value)} description="相同键的重复提交将沿用首次批次" />
              <TextInput label="操作人" value={operator} onChange={(e) => setOperator(e.currentTarget.value)} />
              <Button onClick={startBatch}>开始冻结批次</Button>
            </Stack>
            <Stack gap="xs">
              {train.batches.length === 0 && <Text size="sm" c="dimmed">暂无批次，旧版状态将在下次加载时迁移为历史批次。</Text>}
              {train.batches.map((batch) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  onAdvance={handleAdvance}
                  onFail={(batchId, gateId) => dispatch(failBatchItem({ batchId, gateId, error: '模拟处理失败，等待重试' }))}
                  onRetry={(batchId) => dispatch(retryBatch({ batchId }))}
                />
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">门禁未全部确认时仍可模拟冻结，审计会记录强制决定。</Text>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
