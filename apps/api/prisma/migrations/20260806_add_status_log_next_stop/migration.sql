-- 物流轨迹加「下一站」
--
-- 客户在轨迹里除了看到「过境越南」，还要知道下一步去哪（「下一站【老挝】」）。
-- 推进柜子状态时按状态取默认值（见 containers/routes.ts 的 CONTAINER_NEXT_STOP），
-- 员工也可以在推进时手填覆盖；为空就不显示这一行。
--
-- 只加一列，可空，不动任何一行历史数据 —— 老轨迹的下一站是空的，界面上就不显示。

ALTER TABLE status_logs ADD COLUMN IF NOT EXISTS next_stop TEXT;
