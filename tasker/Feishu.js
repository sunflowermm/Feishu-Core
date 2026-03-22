/**
 * Feishu Tasker：收 Lark 事件 → 策略过滤 → 标准化 → Bot.em("feishu.message"|"feishu.notice")。
 * 回复由 events/feishu.js 统一挂载，插件通过 plugins.deal 消费。
 * 依赖：仅 @larksuiteoapi/node-sdk。配置与行为见 commonconfig/feishu.js。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import fs from "fs/promises";
import { TaskerBase } from "../../../src/infrastructure/bot/tasker.js";
import { EventNormalizer } from "../../../src/utils/event-normalizer.js";
import { FEISHU_PREFIX, DEFAULT_ACCOUNT_ID, escapeForRegex, resolveAccountIdFromData, toSelfId } from "../shared.js";
const MEDIA_TYPES = ["image", "file", "audio", "video", "sticker"];
const MEDIA_PLACEHOLDERS = { image: "[图片]", file: "[文件]", audio: "[语音]", video: "[视频]", sticker: "[表情]" };
const HTTP_TIMEOUT_DEFAULT_MS = 30_000;
const HTTP_TIMEOUT_MAX_MS = 300_000;

function resolveDomain(domain) {
  if (domain === "lark") return Lark.Domain.Lark;
  return (domain === "feishu" || !domain) ? Lark.Domain.Feishu : String(domain).replace(/\/+$/, "");
}

function listAccountIds(cfg) {
  const accounts = cfg?.accounts;
  if (!accounts || typeof accounts !== "object") return [DEFAULT_ACCOUNT_ID];
  return Object.keys(accounts).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function mergeAccountConfig(cfg, accountId) {
  const { accounts, ...base } = cfg ?? {};
  return { ...base, ...(accounts?.[accountId] ?? {}) };
}

function resolveAccount(cfg, accountId) {
  const merged = mergeAccountConfig(cfg, accountId);
  const appId = merged?.appId?.trim();
  const appSecret = merged?.appSecret?.trim();
  const enabled = (cfg?.enabled !== false) && (merged.enabled !== false);
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    enabled,
    configured: !!(appId && appSecret),
    name: merged.name?.trim(),
    appId: appId || undefined,
    appSecret: appSecret || undefined,
    encryptKey: merged?.encryptKey?.trim() || undefined,
    verificationToken: merged?.verificationToken?.trim() || undefined,
    domain: merged?.domain ?? "feishu",
    config: merged,
  };
}

function listEnabledAccounts(cfg) {
  const accounts = listAccountIds(cfg)
    .map((id) => resolveAccount(cfg, id))
    .filter((a) => a.enabled && a.configured);
  const defaultId = (cfg?.defaultAccount ?? "").trim();
  if (!defaultId) return accounts;
  const idx = accounts.findIndex((a) => a.accountId === defaultId);
  if (idx <= 0) return accounts;
  const out = [...accounts];
  const [one] = out.splice(idx, 1);
  out.unshift(one);
  return out;
}

/** allowlist 条目规范化：去掉 feishu:/lark: 前缀后 trim+toLowerCase */
function normalizeAllowEntry(raw) {
  const s = String(raw).trim();
  if (!s) return "";
  const noPrefix = s.replace(/^(feishu|lark):/i, "").trim();
  return noPrefix.toLowerCase();
}

/** allowFrom/groupAllowFrom：支持 "*" 或 open_id 列表，条目可带 feishu:/lark: 前缀 */
function isAllowedByAllowlist(allowFrom, senderOpenId) {
  const list = Array.isArray(allowFrom) ? allowFrom.map(normalizeAllowEntry).filter(Boolean) : [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  const sid = normalizeAllowEntry(senderOpenId ?? "");
  return sid ? list.includes(sid) : false;
}

/** 群级配置：groups[chatId] 或 groups['*'] */
function resolveGroupConfig(cfg, chatId) {
  const groups = cfg?.groups && typeof cfg.groups === "object" ? cfg.groups : {};
  if (!chatId) return groups["*"];
  return groups[chatId] ?? groups[chatId.toLowerCase?.()] ?? groups["*"];
}

/** 群内是否要求 @ 机器人（默认 true），可由 groups 覆盖 */
function resolveRequireMention(merged, cfg, chatType, chatId) {
  if (chatType !== "group") return false;
  const groupConfig = resolveGroupConfig(merged ?? cfg, chatId);
  return groupConfig?.requireMention ?? merged?.requireMention ?? true;
}

/** 创建带超时的 HTTP 实例供 Lark Client 使用 */
function createTimeoutHttpInstance(timeoutMs) {
  const base = Lark.defaultHttpInstance;
  const t = Math.min(Math.max(Number(timeoutMs) || HTTP_TIMEOUT_DEFAULT_MS, 1), HTTP_TIMEOUT_MAX_MS);
  return {
    request: (opts) => base.request({ ...opts, timeout: t }),
    get: (url, opts) => base.get(url, { ...opts, timeout: t }),
    post: (url, data, opts) => base.post(url, data, { ...opts, timeout: t }),
    put: (url, data, opts) => base.put(url, data, { ...opts, timeout: t }),
    patch: (url, data, opts) => base.patch(url, data, { ...opts, timeout: t }),
    delete: (url, opts) => base.delete(url, { ...opts, timeout: t }),
    head: (url, opts) => base.head(url, { ...opts, timeout: t }),
    options: (url, opts) => base.options(url, { ...opts, timeout: t }),
  };
}

function createClient(account) {
  const timeoutMs = (account.config?.httpTimeoutMs != null && Number.isFinite(account.config.httpTimeoutMs))
    ? account.config.httpTimeoutMs
    : HTTP_TIMEOUT_DEFAULT_MS;
  const httpInstance = createTimeoutHttpInstance(timeoutMs);
  return new Lark.Client({
    appId: account.appId,
    appSecret: account.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(account.domain),
    httpInstance,
  });
}

/** 对齐服务端 API GET /open-apis/bot/v3/info，成功时从 data.bot 取 open_id */
async function probeBotOpenId(account) {
  try {
    const res = await createClient(account).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });
    if (res?.code !== 0) return undefined;
    return res?.data?.bot?.open_id;
  } catch {
    return undefined;
  }
}

/** 是否 @ 了机器人（与 package mention 对齐：m.id.open_id） */
function checkBotMentioned(mentions, botOpenId) {
  if (!mentions?.length || !botOpenId) return false;
  return mentions.some((m) => m?.id?.open_id === botOpenId);
}

/** 提及目标列表（排除机器人），与 package extractMentionTargets 对齐 */
function extractMentionTargets(mentions, botOpenId) {
  return (mentions ?? [])
    .filter((m) => m?.id?.open_id && m.id.open_id !== botOpenId)
    .map((m) => ({ openId: m.id.open_id, name: m.name, key: m.key }));
}

/** 是否为“@ 转发”场景：群内需同时 @ 机器人与其他人，私聊为 @ 任意用户 */
function isMentionForwardRequest(mentions, chatType, botOpenId) {
  if (!mentions?.length) return false;
  const hasOther = mentions.some((m) => m?.id?.open_id && m.id.open_id !== botOpenId);
  if (chatType === "p2p") return hasOther;
  const hasBot = mentions.some((m) => m?.id?.open_id === botOpenId);
  return hasBot && hasOther;
}

/** 去掉所有 @ 占位后的正文，与 package extractMessageBody 对齐 */
function extractMessageBody(text, mentionKeys) {
  let out = text;
  for (const key of mentionKeys || []) {
    if (!key) continue;
    out = out.replace(new RegExp(escapeForRegex(key), "g"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 解析消息内容：文本 + 媒体 key，与 package parseMessageContent/parsePostContent 对齐 */
function parseContent(content, messageType) {
  let text = "";
  const mediaKeys = [];
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    if (messageType === "text") {
      text = parsed?.text ?? "";
      return { text, mediaKeys, messageType };
    }
    if (messageType === "post") {
      const title = parsed?.title ?? "";
      if (title) text = `${title}\n\n`;
      const blocks = parsed?.content ?? [];
      for (const row of blocks) {
        if (!Array.isArray(row)) continue;
        for (const el of row) {
          if (el?.tag === "text") text += el?.text ?? "";
          if (el?.tag === "a") text += el?.text || el?.href || "";
          if (el?.tag === "at") text += `@${el?.user_name || el?.user_id || ""}`;
          if (el?.tag === "img" && el?.image_key) mediaKeys.push({ type: "image", image_key: el.image_key });
        }
        text += "\n";
      }
      text = text.trim() || "[富文本消息]";
      return { text, mediaKeys, messageType };
    }
    if (MEDIA_TYPES.includes(messageType)) {
      const key = parsed?.image_key ? { type: messageType, image_key: parsed.image_key } : { type: messageType, file_key: parsed?.file_key, file_name: parsed?.file_name };
      if (key.image_key || key.file_key) mediaKeys.push(key);
      text = MEDIA_PLACEHOLDERS[messageType] ?? "[媒体]";
      return { text, mediaKeys, messageType };
    }
  } catch {}
  return { text: String(content || ""), mediaKeys, messageType };
}

function stripMentions(text, mentions) {
  if (!mentions?.length) return text;
  let out = text;
  for (const m of mentions) {
    const name = escapeForRegex(m.name || "");
    if (name) out = out.replace(new RegExp(`@${name}\\s*`, "g"), "").trim();
    if (m.key) out = out.replace(new RegExp(escapeForRegex(m.key), "g"), "").trim();
  }
  return out;
}

/** 构建 message 数组：文本段 + 媒体段（type + url/key 占位） */
function buildMessageSegments(text, mediaKeys, feishuMessageId) {
  const segs = [];
  if (text) segs.push({ type: "text", text });
  for (const m of mediaKeys) {
    if (m.image_key) segs.push({ type: "image", url: `feishu:${feishuMessageId}:${m.image_key}` });
    else if (m.file_key) segs.push({ type: m.type === "audio" ? "record" : m.type === "video" ? "video" : "file", file: `feishu:${feishuMessageId}:${m.file_key}`, file_name: m.file_name });
  }
  return segs.length ? segs : [{ type: "text", text: "" }];
}

function receiveIdType(id) {
  const t = String(id).trim();
  if (t.startsWith("oc_")) return "chat_id";
  if (t.startsWith("ou_")) return "open_id";
  return "user_id";
}

function normalizeTo(receiveId) {
  const t = receiveId.trim().toLowerCase();
  if (t.startsWith("chat:")) return t.slice(5).trim();
  if (t.startsWith("user:")) return t.slice(5).trim();
  return t;
}

class FeishuTasker {
  id = "Feishu";
  name = "Feishu";
  path = "feishu";
  _wsClients = new Map();
  _botOpenIds = new Map();

  /** 使用 ConfigBase 的缓存，避免每条消息都读盘；需热更新时由配置层 reload 或重启进程 */
  async _getFeishuCfg() {
    const config = global.ConfigManager?.get?.("feishu");
    if (!config?.read) return null;
    try {
      return await config.read(true);
    } catch (e) {
      Bot.makeLog("warn", `[Feishu] 读取配置失败: ${e?.message}`, "Feishu");
      return null;
    }
  }

  async load() {
    const cfg = await this._getFeishuCfg();
    if (!cfg?.enabled) {
      Bot.makeLog("info", "[Feishu] 未启用，跳过", "Feishu");
      return;
    }
    const accounts = listEnabledAccounts(cfg);
    if (!accounts.length) {
      Bot.makeLog("warn", "[Feishu] 无可用账号", "Feishu");
      return;
    }
    for (const account of accounts) {
      try {
        await this._startAccount(account);
      } catch (err) {
        Bot.makeLog("error", `[Feishu] 启动 ${account.accountId} 失败: ${err?.message}`, "Feishu", err);
      }
    }
  }

  async _startAccount(account) {
    if (account.config?.appSecretFile && !account.appSecret) {
      try {
        const secret = await fs.readFile(account.config.appSecretFile, "utf8");
        account.appSecret = (secret || "").trim();
        account.configured = !!(account.appId && account.appSecret);
      } catch (e) {
        Bot.makeLog("warn", `[Feishu] 读取 appSecret 文件失败: ${account.config.appSecretFile}`, "Feishu", e);
        return;
      }
    }
    if (!account.configured) return;
    const { accountId } = account;
    const botOpenId = await probeBotOpenId(account);
    this._botOpenIds.set(accountId, botOpenId ?? "");
    Bot.makeLog("info", `[Feishu] ${accountId} bot open_id: ${botOpenId ?? "unknown"}`, "Feishu");

    const selfId = toSelfId(accountId);
    if (!Bot[selfId]) {
      TaskerBase.createBotInstance(
        { id: selfId, name: account.name || `Feishu-${accountId}`, type: "feishu", info: { bot_open_id: botOpenId }, tasker: this },
        Bot
      );
      if (!Bot.uin.includes(selfId)) Bot.uin.push(selfId);
    }

    if ((account.config?.connectionMode ?? "websocket") === "webhook") {
      Bot.makeLog("warn", "[Feishu] webhook 需自行挂载，当前仅 websocket", "Feishu");
      return;
    }

    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: account.encryptKey,
      verificationToken: account.verificationToken,
    });

    eventDispatcher.register({
      "im.message.receive_v1": (data) => this._onMessage(accountId, data),
      "im.message.message_read_v1": () => {},
      "im.chat.member.bot.added_v1": (data) => this._onNotice(accountId, "bot_added", data),
      "im.chat.member.bot.deleted_v1": (data) => this._onNotice(accountId, "bot_deleted", data),
    });

    const wsClient = new Lark.WSClient({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: resolveDomain(account.domain),
      loggerLevel: Lark.LoggerLevel.info,
    });
    this._wsClients.set(accountId, wsClient);
    wsClient.start({ eventDispatcher });
    Bot.makeLog("mark", `[Feishu] ${accountId} WebSocket 已启动`, "Feishu");
  }

  async _onMessage(accountId, rawEvent) {
    const message = rawEvent?.message;
    const sender = rawEvent?.sender;
    if (!message || !sender) return;

    const chatType = message.chat_type || "p2p";
    const isGroup = chatType === "group";
    const senderOpenId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";
    const chatId = message.chat_id || "";

    const cfg = await this._getFeishuCfg();
    const merged = cfg ? mergeAccountConfig(cfg, accountId) : {};
    if (isGroup) {
      const groupPolicy = merged.groupPolicy === "allowall" ? "open" : (merged.groupPolicy ?? "open");
      if (groupPolicy === "disabled") return;
      if (groupPolicy === "allowlist" && !isAllowedByAllowlist(merged.groupAllowFrom, senderOpenId)) return;
      const requireMention = resolveRequireMention(merged, cfg, chatType, chatId);
      if (requireMention && !checkBotMentioned(message.mentions ?? [], this._botOpenIds.get(accountId))) return;
    } else {
      if (merged.dmPolicy === "disabled") return;
      if (merged.dmPolicy === "allowlist" && !isAllowedByAllowlist(merged.allowFrom, senderOpenId)) return;
    }

    const msgType = message.message_type || "text";
    const mentions = message.mentions ?? [];
    const botOpenId = this._botOpenIds.get(accountId);
    const { text, mediaKeys } = parseContent(message.content, msgType);
    const content = stripMentions(text, mentions);
    const selfId = toSelfId(accountId);

    const mentionedBot = checkBotMentioned(mentions, botOpenId);
    const mentionTargets = isMentionForwardRequest(mentions, chatType, botOpenId)
      ? extractMentionTargets(mentions, botOpenId)
      : [];
    const mentionMessageBody = mentionTargets.length > 0
      ? extractMessageBody(content, mentions.map((m) => m.key))
      : undefined;

    const data = {
      post_type: "message",
      message_type: isGroup ? "group" : "private",
      self_id: selfId,
      user_id: senderOpenId,
      group_id: isGroup ? chatId : null,
      chat_id: chatId,
      message_id: message.message_id,
      raw_message: content,
      msg: content,
      message: buildMessageSegments(content, mediaKeys, message.message_id),
      time: Math.floor(Date.now() / 1000),
      feishu_account_id: accountId,
      feishu_event: rawEvent,
      feishu_message_type: msgType,
      feishu_media_keys: mediaKeys,
      feishu_chat_type: chatType,
      root_id: message.root_id,
      parent_id: message.parent_id,
      mentionedBot,
      ...(mentionTargets.length > 0 && { mentionTargets, mentionMessageBody }),
    };

    data.bot = Bot[selfId] || null;
    if (!data.bot) {
      Bot.makeLog("warn", `[Feishu] Bot 不存在: ${selfId}`, selfId);
      return;
    }
    data.event_id = `feishu_${selfId}_${message.message_id}_${data.time}`;
    data.tasker = "feishu";
    data.isFeishu = true;
    data.isGroup = isGroup;
    data.isPrivate = !isGroup;
    data.sender = { user_id: senderOpenId, nickname: sender.sender_id?.name || senderOpenId, card: sender.sender_id?.name || senderOpenId };
    EventNormalizer.normalize(data, { defaultPostType: "message", defaultMessageType: data.message_type, defaultSubType: isGroup ? "normal" : "friend", defaultUserId: senderOpenId });
    Bot.makeLog("info", `[Feishu] 消息 ${selfId} <= ${isGroup ? chatId : senderOpenId}`, selfId);
    Bot.em("feishu.message", data);
  }

  _onNotice(accountId, subType, rawEvent) {
    const chatId = rawEvent?.chat_id ?? rawEvent?.event?.chat_id;
    const operatorId = rawEvent?.operator_id ?? rawEvent?.event?.operator?.id ?? rawEvent?.event?.operator_id;
    const selfId = toSelfId(accountId);
    const data = {
      post_type: "notice",
      sub_type: subType,
      self_id: selfId,
      group_id: chatId || null,
      chat_id: chatId,
      operator_id: operatorId,
      time: Math.floor(Date.now() / 1000),
      feishu_account_id: accountId,
      feishu_event: rawEvent,
    };
    data.bot = Bot[selfId] || null;
    data.event_id = `feishu_${selfId}_notice_${subType}_${data.time}`;
    data.tasker = "feishu";
    data.isFeishu = true;
    if (data.bot) Bot.em("feishu.notice", data);
    Bot.makeLog("info", `[Feishu] 通知 ${subType} chat=${chatId}`, selfId);
  }

  async sendFriendMsg(data, msg) {
    const accountId = resolveAccountIdFromData(data);
    const userId = data?.user_id || data?.sender_open_id;
    if (!accountId || !userId) return null;
    return this._send(accountId, `user:${userId}`, msg, data.message_id);
  }

  async sendGroupMsg(data, msg) {
    const accountId = resolveAccountIdFromData(data);
    const chatId = data?.group_id || data?.chat_id;
    if (!accountId || !chatId) return null;
    return this._send(accountId, `chat:${chatId}`, msg, data.message_id);
  }

  async _send(accountId, to, text, replyToMessageId) {
    const cfg = await this._getFeishuCfg();
    if (!cfg) throw new Error("Feishu 配置不可用");
    const account = resolveAccount(cfg, accountId);
    if (!account.configured) throw new Error(`Feishu 账号 "${accountId}" 未配置`);
    const receiveId = normalizeTo(to);
    if (!receiveId) throw new Error(`无效目标: ${to}`);
    let contentText = String(text ?? "");
    const prefix = account.config?.responsePrefix;
    if (prefix && typeof prefix === "string") contentText = prefix.trim() + contentText;
    const isReply = Boolean(replyToMessageId);
    const isGroupTarget = receiveIdType(receiveId) === "chat_id";
    const replyInThread = isReply && isGroupTarget && (account.config?.replyInThread === "enabled");
    const renderMode = account.config?.renderMode ?? "auto";
    const useRawText = renderMode === "raw";
    const body = useRawText
      ? JSON.stringify({ text: contentText })
      : JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: contentText }]] } });
    const msgType = useRawText ? "text" : "post";
    const client = createClient(account);
    if (replyToMessageId) {
      const replyData = { content: body, msg_type: msgType, ...(replyInThread ? { reply_in_thread: true } : {}) };
      const res = await client.im.message.reply({ path: { message_id: replyToMessageId }, data: replyData });
      if (res?.code !== 0) throw new Error(res?.msg || `code ${res?.code}`);
      return { message_id: res.data?.message_id, chat_id: receiveId };
    }
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType(receiveId) },
      data: { receive_id: receiveId, content: body, msg_type: msgType },
    });
    if (res?.code !== 0) throw new Error(res?.msg || `code ${res?.code}`);
    return { message_id: res.data?.message_id, chat_id: receiveId };
  }
}

const _feishuTasker = new FeishuTasker();
if (!Bot.tasker?.some((t) => t?.path === _feishuTasker.path)) Bot.tasker.push(_feishuTasker);
