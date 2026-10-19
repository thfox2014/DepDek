export const BITBAY_API_ORIGIN = "https://api.bitbay.site";
const ERRORS: Record<string, string> = {
  BITBAY_EMAIL_INVALID: "请输入有效的邮箱地址。",
  BITBAY_CODE_INVALID: "验证码错误或已过期，请检查邮件或重新获取。",
  BITBAY_PASSWORD_INVALID: "注册密码需为 12–20 字节；已有平台密码为 6–20 字节。请勿包含换行。",
  BITBAY_RATE_LIMITED: "发送过于频繁，请等待 60 秒后重试。",
  BITBAY_ALREADY_REGISTERED: "这个邮箱已注册 BitBay，请切换到“已有账户登录”。",
  BITBAY_LOGIN_FAILED: "邮箱或平台密码不正确，或账户暂不可用。",
  BITBAY_UNAVAILABLE: "BitBay 服务暂不可用，请稍后重试。",
  BITBAY_OUTCOME_UNKNOWN: "未能确认平台处理结果。可能已完成注册，请先使用已有账户登录，不要重复注册。",
  BITBAY_REQUEST_REJECTED: "平台未接受请求，请检查邮箱、验证码和密码。",
  BITBAY_LOCAL_SAVE_FAILED: "平台验证已成功，但本机保存失败。请检查磁盘空间，再使用已有账户登录恢复。",
  LOCAL_UNLOCK_PASSWORD_REQUIRED: "请设置至少 12 字节的本机空间密码，不能包含控制字符。",
  LOGIN_REQUIRED: "已有本机空间，请先解锁下方本机账户，再关联 BitBay。",
  CONFLICT: "本机空间已有关联账户，请刷新后检查，不能在此替换身份。",
  AUDIT_UNAVAILABLE: "操作记录无法保存，请检查本机磁盘空间后重试。",
};
export function bitBayError(error: unknown) {
  return ERRORS[String(error).replace(/^Error: /, "")] ?? "暂时无法完成 BitBay 操作，请稍后重试。";
}
export function bitBayEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error("BITBAY_EMAIL_INVALID");
  return email;
}
export function passwordBytes(value: string): number { return new TextEncoder().encode(value).length; }
