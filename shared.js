/**
 * Feishu-Core 共享常量与工具，供 commonconfig / tasker / events 复用，避免重复实现。
 */

export const FEISHU_PREFIX = "feishu_";
export const DEFAULT_ACCOUNT_ID = "default";

/** 由账号 ID 得到 Bot 侧 self_id（如 feishu_default） */
export function toSelfId(accountId) {
  return FEISHU_PREFIX + (accountId ?? DEFAULT_ACCOUNT_ID);
}

/**
 * 解析服务端口：优先 cfg.port / cfg._port，其次 process.argv 的 server <port>
 * @param {object} [cfg]
 * @returns {number|null}
 */
export function resolveServerPort(cfg) {
  const fromCfg = cfg?.port ?? cfg?._port;
  if (fromCfg != null && !Number.isNaN(Number(fromCfg))) return Number(fromCfg);
  const idx = process.argv.indexOf("server");
  if (idx >= 0 && process.argv[idx + 1]) {
    const p = parseInt(process.argv[idx + 1], 10);
    if (!Number.isNaN(p)) return p;
  }
  return null;
}

/**
 * 正则特殊字符转义（用于动态构造 RegExp）
 * @param {string} str
 * @returns {string}
 */
export function escapeForRegex(str) {
  if (str == null) return "";
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从事件/发送上下文 data 中解析出飞书账号 ID（供 sendFriendMsg / sendGroupMsg 等使用）
 * @param {object} data - 含 feishu_account_id 或 self_id 的对象
 * @returns {string|null}
 */
export function resolveAccountIdFromData(data) {
  if (!data) return null;
  if (data.feishu_account_id != null && data.feishu_account_id !== "") return String(data.feishu_account_id);
  const selfId = data.self_id;
  if (typeof selfId === "string" && selfId.startsWith(FEISHU_PREFIX)) return selfId.slice(FEISHU_PREFIX.length);
  return null;
}
