# pair-wise-yf-53 开源项目发布列车准备和门禁控制台

## 源提示词摘要
维护者创建跨仓库发布，关联版本、负责人、阻断问题和待合并依赖，安排冻结时间与分批顺序。发布前检查依赖、阻断、超时确认和顺序冲突，支持冻结、降级、回滚准备状态及可追溯审计。

## 技术栈
React Router 7 框架模式 + TypeScript + Mantine + Redux Toolkit + RTK Query + React Hook Form + Zod + Lingui + dnd-kit。

## 已实现闭环
- 跨仓库发布列车、依赖门禁和阻断问题三类业务对象。
- 门禁确认、阻断关闭、发布冻结、回滚和恢复准备状态。
- 仓库顺序拖拽、表单校验、远端健康查询与审计历史。
- localStorage 持久化。

## 启动
```bash
npm install
npm run dev
```
开发端口：62018
