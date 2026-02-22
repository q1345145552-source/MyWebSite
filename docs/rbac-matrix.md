# 湘泰国际物流 - RBAC 权限矩阵

## 1. 角色
- admin
- staff
- client

## 2. 菜单权限
### admin
- Dashboard
- 用户与角色管理
- 系统配置
- 运单总览
- 报表中心

### staff
- 工作台
- 运单列表
- 运单详情
- 状态更新
- 异常处理
- 物流信息补录

### client
- 我的订单
- 下单（物流预报单）
- 运单查询
- 费用明细
- 售后工单

## 3. 动作权限（统一版）
- shipment.read: admin/staff/client 允许（client 仅本人）
- shipment.updateStatus: admin/staff 允许，client 禁止
- user.manage: 仅 admin 允许
- config.manage: 仅 admin 允许
- prealert.create: client/staff/admin 允许
- order.create: admin/staff 允许，client 禁止

## 4. 数据范围（统一版）
- admin: 全量可见 + 全量可改
- staff: 可跨仓查询（只读），仅可修改授权仓库数据
- client: 仅本人数据

## 5. Client V1 对应权限点
- prealert.create
  - client: allow
  - staff: allow（可代客录入）
  - admin: allow

- shipment.search
  - client: allow（仅本人）
  - staff: allow（跨仓只读）
  - admin: allow（全量）

- order.list
  - client: allow（仅本人）
  - staff: allow（跨仓只读）
  - admin: allow（全量）

## 6. Staff V1 补充权限（状态与仓库范围）
- shipment.read
  - admin: allow（全量）
  - staff: allow（跨仓只读）
  - client: allow（仅本人）

- shipment.updateStatus
  - admin: allow
  - staff: allow（仅授权仓库）
  - client: deny

- shipment.updateStatus.crossWarehouse
  - admin: allow
  - staff: deny
  - client: deny

- shipment.auditTrail.read
  - admin: allow
  - staff: allow（至少可查看本人操作记录）
  - client: deny

## 7. Staff 创建订单与物流字段补录权限
- order.create
  - admin: allow
  - staff: allow
  - client: deny

- order.logisticsInfo.read
  - admin: allow
  - staff: allow
  - client: allow（只读）

- order.logisticsInfo.update
  - admin: allow
  - staff: allow
  - client: deny

- shipment.trackingInfo.update
  - admin: allow
  - staff: allow
  - client: deny

## 8. Admin V1 补充权限
- admin.dashboard.read
  - admin: allow
  - staff: deny
  - client: deny

- admin.user.manage
  - admin: allow
  - staff: deny
  - client: deny

- admin.warehouse.assign
  - admin: allow
  - staff: deny
  - client: deny

- admin.dictionary.manage
  - admin: allow
  - staff: deny
  - client: deny

- admin.transportMode.manage
  - admin: allow
  - staff: deny
  - client: deny

- admin.shipment.status.update
  - admin: allow
  - staff: deny
  - client: deny

- admin.auditLog.read
  - admin: allow
  - staff: deny
  - client: deny

## 9. Client V1 AI 对话权限
- ai.chat.ask
  - admin: deny
  - staff: deny
  - client: allow（同公司范围）

- ai.chat.suggestions.read
  - admin: deny
  - staff: deny
  - client: allow

- ai.audit.read
  - admin: allow（全量）
  - staff: deny
  - client: deny