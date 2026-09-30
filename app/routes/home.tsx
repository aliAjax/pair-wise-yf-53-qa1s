import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import { activateTrain, confirmGate, createTrain, reorderGates, resolveBlocker, setFreeze, useGetTrainHealthQuery, type RepositoryGate } from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

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

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: { train: ReturnType<typeof import('../store').store.getState>['train'] }) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。任何未确认门禁都会阻止冻结。</Text></div>
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
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} onConfirm={() => dispatch(confirmGate(gate.id))} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>
        </Stack>

        <Stack>
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
