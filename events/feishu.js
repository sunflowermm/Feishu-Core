/**
 * 飞书事件监听：订阅 feishu.message / feishu.notice，标准化后交给插件链（plugins.deal）。
 * 回复能力在此统一挂载 e.reply，与其它通道一致，由插件层统一消费。
 */
import EventListenerBase from "../../../src/infrastructure/listener/base.js";
import { errorHandler, ErrorCodes } from "../../../src/utils/error-handler.js";

export default class FeishuEvent extends EventListenerBase {
  _listenersInitialized = false;

  constructor() {
    super("feishu");
  }

  async init() {
    if (this._listenersInitialized) return;
    const bot = this.bot || Bot;
    bot.on("feishu.message", (e) => this.handle(e, true));
    bot.on("feishu.notice", (e) => this.handle(e, false));
    this._listenersInitialized = true;
  }

  normalizeBase(e) {
    e.bot = e.bot || (e.self_id ? Bot[e.self_id] : null);
    if (!e.bot) {
      Bot.makeLog("warn", `[Feishu] Bot 不存在: ${e.self_id}`, e.self_id);
      return false;
    }
    this.ensureEventId(e);
    if (!this.markProcessed(e)) return false;
    this.markAdapter(e, { isFeishu: true });
    return true;
  }

  setupReply(e) {
    if (e.reply || !e.bot?.tasker) return;
    const tasker = e.bot.tasker;
    e.reply = async (msg = "") => {
      if (msg == null) return false;
      try {
        if (e.message_type === "group" && e.group_id) return await tasker.sendGroupMsg(e, msg);
        if (e.message_type === "private" && e.user_id) return await tasker.sendFriendMsg(e, msg);
        Bot.makeLog("warn", "[Feishu] 无法发送", e.self_id);
        return false;
      } catch (err) {
        errorHandler.handle(err, { context: "FeishuEvent.reply", selfId: e.self_id, code: ErrorCodes.SYSTEM_ERROR }, true);
        return false;
      }
    };
  }

  async handle(e, isMessage) {
    try {
      if (!this.normalizeBase(e)) return;
      if (isMessage && e.post_type === "message") this.setupReply(e);
      await this.plugins.deal(e);
    } catch (err) {
      errorHandler.handle(err, { context: "FeishuEvent.handle", selfId: e?.self_id, code: ErrorCodes.SYSTEM_ERROR }, true);
      Bot.makeLog("error", `[Feishu] 处理失败: ${err?.message}`, e?.self_id, err);
    }
  }
}
