/**
 * 密码强度规则（三端共用）。
 *
 * 2026-08-07 加的。当天普查发现 75 个账号里有 69 个的密码能被直接猜到：
 * 大多是「密码和账号名一模一样」，其余是 123456 这类。根子在于
 * 开账号和重设密码的地方从来不校验强度，只要求「非空」或「6 位」。
 *
 * ⚠️ 目前只对**员工和管理员**账号强制执行。客户账号沿用旧规则 ——
 * 用户 2026-08-07 明确说「客户端那边不用管」，因为客户的密码普遍就是唛头本身，
 * 一刀切改掉会让 66 个客户当场登不进去。要改客户那边前先问他。
 */

/** 太容易被猜到的密码，一律不让用。 */
const WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "88888888", "66666666", "11111111",
  "password", "password1", "passw0rd", "qwertyui", "abc12345", "admin123",
  "administrator", "xiangtai", "xiangtai123", "wuliu123", "12341234",
]);

/**
 * 校验密码强度。返回 null 表示通过，否则返回给用户看的中文原因。
 *
 * @param newPassword 要设的新密码
 * @param oldPassword 旧密码；自助改密码时传，管理员重设别人的密码时不传
 * @param account     账号名；传了就会检查「密码和账号名一样」这种情况
 */
export function checkPasswordStrength(
  newPassword: string,
  oldPassword?: string,
  account?: string,
): string | null {
  if (newPassword.length < 8) return "密码至少 8 位";
  if (newPassword.length > 128) return "密码太长了（最多 128 位）";
  if (oldPassword && newPassword === oldPassword) return "新密码不能和旧密码一样";
  if (account && newPassword.toLowerCase() === account.toLowerCase()) return "密码不能和账号名一样";
  if (WEAK_PASSWORDS.has(newPassword.toLowerCase())) return "这个密码太常见了，换一个";
  if (/^(.)\1+$/.test(newPassword)) return "密码不能是同一个字符重复";
  if (/^\d+$/.test(newPassword)) return "密码不能全是数字，请加上字母";
  return null;
}
