/**
 * Feishu-Core 飞书通道配置
 *
 * - 路径：data/server_bots/{port}/feishu.yaml（随端口）
 * - 缺失时从本 Core commonconfig/feishu.default.yaml 复制到该路径，不写入项目根或底层目录
 * - 业务通过 ConfigManager.get('feishu') 后 read() 使用
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import ConfigBase from "../../../src/infrastructure/commonconfig/commonconfig.js";
import BotUtil from "../../../src/utils/botutil.js";
import { resolveServerPort } from "../shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 本 Core 内默认配置参考，仅在此处使用，复制目标为 data/server_bots/{port}/feishu.yaml */
const DEFAULT_TEMPLATE = path.join(__dirname, "feishu.default.yaml");

export default class FeishuConfig extends ConfigBase {
  constructor() {
    super({
      name: "feishu",
      displayName: "飞书通道配置",
      description: "飞书通道配置，策略/发送/多账号等字段完整",
      filePath: (cfg) => {
        const port = resolveServerPort(cfg ?? global.cfg);
        if (!port) throw new Error("FeishuConfig: 需要端口 (global.cfg.port 或 node app server <port>)");
        return path.join("data", "server_bots", String(port), "feishu.yaml");
      },
      fileType: "yaml",
      schema: {
        fields: {
          enabled: { type: "boolean", label: "启用", default: false, component: "Switch", group: "基础" },
          name: { type: "string", label: "账号名称", description: "本端账号展示名", component: "Input", placeholder: "可选", group: "基础" },
          domain: { type: "string", label: "域名", enum: ["feishu", "lark"], default: "feishu", component: "Select", group: "基础" },
          connectionMode: { type: "string", label: "连接模式", enum: ["websocket", "webhook"], default: "websocket", component: "Select", group: "基础" },

          appId: { type: "string", label: "App ID", description: "飞书开放平台应用 App ID", component: "Input", placeholder: "cli_xxx", group: "应用凭证" },
          appSecret: { type: "string", label: "App Secret", component: "InputPassword", group: "应用凭证" },
          appSecretFile: { type: "string", label: "App Secret 文件路径", description: "可选，从文件读取以替代直接填 Secret", component: "Input", placeholder: "data/feishu_secret.txt", group: "应用凭证" },
          encryptKey: { type: "string", label: "encryptKey", description: "事件回调加密密钥", component: "Input", group: "应用凭证" },
          verificationToken: { type: "string", label: "verificationToken", description: "事件回调校验 Token", component: "Input", group: "应用凭证" },

          webhookPath: { type: "string", label: "webhookPath", description: "webhook 模式下事件回调路径", default: "/feishu/events", component: "Input", placeholder: "/feishu/events", group: "连接" },
          webhookPort: { type: "number", label: "webhookPort", min: 1, default: 3000, component: "InputNumber", group: "连接" },
          botName: { type: "string", label: "机器人名称", component: "Input", group: "连接" },

          dmPolicy: { type: "string", label: "私聊策略", enum: ["pairing", "allowlist", "open", "disabled"], default: "open", component: "Select", group: "策略" },
          groupPolicy: { type: "string", label: "群策略", enum: ["open", "allowlist", "allowall", "disabled"], default: "open", component: "Select", group: "策略" },
          allowFrom: { type: "array", label: "私聊允许来源(open_id)", itemType: "string", default: [], component: "Tags", placeholder: "每行一个 open_id", group: "策略" },
          groupAllowFrom: { type: "array", label: "群聊允许来源(open_id)", itemType: "string", default: [], component: "Tags", group: "策略" },
          requireMention: { type: "boolean", label: "群内需@机器人", default: true, component: "Switch", group: "策略" },
          topicSessionMode: { type: "string", label: "话题会话", enum: ["disabled", "enabled"], default: "disabled", component: "Select", group: "策略" },
          groupSessionScope: { type: "string", label: "群会话作用域", enum: ["group", "group_sender", "group_topic", "group_topic_sender"], default: "group", component: "Select", group: "策略" },
          replyInThread: { type: "string", label: "群内回复到话题", enum: ["disabled", "enabled"], default: "disabled", component: "Select", group: "策略" },
          reactionNotifications: { type: "string", label: "反应通知", enum: ["off", "own", "all"], default: "own", component: "Select", group: "策略" },

          historyLimit: { type: "number", label: "群历史条数", min: 0, default: 0, component: "InputNumber", description: "0 表示不限制", group: "限制" },
          dmHistoryLimit: { type: "number", label: "私聊历史条数", min: 0, default: 0, component: "InputNumber", group: "限制" },
          textChunkLimit: { type: "number", label: "textChunkLimit", min: 1, default: 4096, component: "InputNumber", group: "限制" },
          chunkMode: { type: "string", label: "chunkMode", enum: ["length", "newline"], default: "length", component: "Select", group: "限制" },
          mediaMaxMb: { type: "number", label: "媒体最大MB", min: 0, default: 30, component: "InputNumber", group: "限制" },

          blockStreaming: { type: "boolean", label: "blockStreaming", default: false, component: "Switch", group: "流式与展示" },
          streaming: { type: "boolean", label: "streaming", default: true, component: "Switch", group: "流式与展示" },
          responsePrefix: { type: "string", label: "回复前缀", component: "Input", group: "流式与展示" },
          renderMode: { type: "string", label: "renderMode", enum: ["auto", "raw", "card"], default: "auto", component: "Select", group: "流式与展示" },

          defaultAccount: { type: "string", label: "默认账号 ID", component: "Input", placeholder: "多账号时指定默认", group: "高级" },
          httpTimeoutMs: { type: "number", label: "HTTP 超时(ms)", min: 1000, default: 30000, component: "InputNumber", group: "高级" },
          typingIndicator: { type: "boolean", label: "输入状态指示", default: true, component: "Switch", group: "高级" },
          resolveSenderNames: { type: "boolean", label: "解析发送者名称", default: true, component: "Switch", group: "高级" },
          tools: {
            type: "object",
            label: "工具开关",
            description: "doc/chat/wiki/drive 开关；perm 为权限对象，scopes 为 scope 列表",
            component: "SubForm",
            example: { doc: true, chat: true, wiki: true, drive: true, perm: {}, scopes: ["im:message"] },
            group: "扩展",
            fields: {
              doc: { type: "boolean", label: "doc", default: true, component: "Switch" },
              chat: { type: "boolean", label: "chat", default: true, component: "Switch" },
              wiki: { type: "boolean", label: "wiki", default: true, component: "Switch" },
              drive: { type: "boolean", label: "drive", default: true, component: "Switch" },
              perm: {
                type: "object",
                label: "perm",
                description: "权限相关键值，可键值/JSON 编辑",
                component: "SubForm",
                fields: {}
              },
              scopes: {
                type: "array",
                label: "scopes",
                description: "如 im:message、contact:user.base 等",
                itemType: "string",
                default: [],
                component: "Tags"
              }
            }
          },
          heartbeat: {
            type: "object",
            label: "心跳",
            description: "visibility 与 intervalMs，用于保活与可见性",
            component: "SubForm",
            example: { visibility: "", intervalMs: 30000 },
            group: "扩展",
            fields: {
              visibility: { type: "string", label: "visibility", component: "Input" },
              intervalMs: { type: "number", label: "intervalMs", min: 0, default: 30000, component: "InputNumber" }
            }
          },
          blockStreamingCoalesce: {
            type: "object",
            label: "流式合并",
            description: "合并流式输出块，减少推送次数",
            component: "SubForm",
            example: { enabled: false, minDelayMs: 0, maxDelayMs: 0 },
            group: "扩展",
            fields: {
              enabled: { type: "boolean", label: "enabled", default: false, component: "Switch" },
              minDelayMs: { type: "number", label: "minDelayMs", min: 0, default: 0, component: "InputNumber" },
              maxDelayMs: { type: "number", label: "maxDelayMs", min: 0, default: 0, component: "InputNumber" }
            }
          },
          groups: {
            type: "object",
            label: "群级配置",
            description: "键为 chat_id 或 '*'，值为该群 requireMention/allowFrom 等，键值或 JSON 编辑",
            component: "SubForm",
            fields: {},
            example: { "*": { requireMention: true, allowFrom: [] } },
            group: "扩展"
          },
          accounts: {
            type: "object",
            label: "多账号",
            description: "键为账号 id，值为该账号配置，键值或 JSON 编辑",
            component: "SubForm",
            fields: {},
            example: { default: { appId: "", appSecret: "" } },
            group: "扩展"
          },
        },
      },
    });
  }

  /**
   * 若 data/server_bots/{port}/feishu.yaml 不存在，则从本 Core 的 feishu.default.yaml 复制到该路径后再读；
   * 缓存由 ConfigBase 统一处理，此处仅负责”缺文件时复制默认模板”。
   */
  async read(useCache = true) {
    let targetPath;
    try {
      targetPath = this.getFilePath();
    } catch {
      return await super.read(useCache);
    }
    if (!fsSync.existsSync(targetPath) && fsSync.existsSync(DEFAULT_TEMPLATE)) {
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(DEFAULT_TEMPLATE, targetPath);
        BotUtil.makeLog(“info”, `[Feishu] 已从默认模板创建: ${targetPath}`, “FeishuConfig”);
      } catch (e) {
        BotUtil.makeLog(“warn”, `[Feishu] 创建默认配置失败: ${e?.message}`, “FeishuConfig”);
      }
    }
    return await super.read(useCache);
  }

  /**
   * 写入配置前自动清理空值，避免保存冗余数据
   * 使用底层 ConfigBase 的 cleanEmpty 选项
   */
  async write(data, options = {}) {
    return await super.write(data, { ...options, cleanEmpty: true });
  }
}
