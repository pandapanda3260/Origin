// 任务"原因"字段的唯一 SQL 口径（2026-06 瘦身阶段3下沉）。
// 背景：COALESCE(error_message, error_msg, ...) 此前在 problem-queue 与 tasks API 里手抄了 9+ 遍，
// 且各表列结构不同——video_tasks / exports 没有 status_reason 列（2026-06-12 风险词库审查实锤），
// batches 只有 error_message。手抄时极易抄错列，统一从这里取。
//
// 用法：SELECT ${batchTaskReasonSql('bt')} AS reason ...

/** batches 表：只有 error_message。 */
export function batchReasonSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}error_message, '')`;
}

/** batch_tasks 表：status_reason 优先（admin 重排等会写入），其次两个 error 列。 */
export function batchTaskReasonSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}status_reason, ${a}error_message, ${a}error_msg, '')`;
}

/** video_tasks / exports 表：没有 status_reason 列，禁止加第三列（会直接 SQL 报错）。 */
export function simpleTaskReasonSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}error_message, ${a}error_msg, '')`;
}
