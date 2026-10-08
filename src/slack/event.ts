import type { DotBridgeConfig } from "../config.js";
import { App } from "@slack/bolt";

/** Slack 消息数据结构 */
export interface SlackMessageData {
  /** 频道 ID */
  channel: string;
  subtype?: string;
  /** 消息时间戳（消息 ID） */
  messageTs: string;
  /** 线程时间戳（回复时存在） */
  threadTs?: string;
  /** 消息文本内容 */
  text: string;
  /** 发送者用户 ID */
  userId: string;
  /** Bot ID（如果是 bot 发送的） */
  botId?: string;
  /** 附件文件列表 */
  files?: Array<{
    /** 文件下载 URL */
    url: string;
    /** 文件名 */
    name: string;
    /** MIME 类型 */
    mimetype: string;
  }>;
}

/** Slack 消息处理回调函数 */
export type SlackMessageHandler = (data: SlackMessageData) => void | Promise<void>;

/**
 * 创建并配置 Slack Bolt App（Socket Mode）
 * 注册消息监听器，提取消息数据后调用回调函数
 *
 * @param botToken Bot Token（xoxb- 开头）
 * @param appToken App Token（xapp- 开头），用于 Socket Mode
 * @param onMessage 消息处理回调
 * @returns Bolt App 实例（调用方需手动 await app.start()）
 */
export function createSlackApp(
  botToken: string,
  appToken: string,
  onMessage: SlackMessageHandler,
  dotBridge?: DotBridgeConfig,
  selfUserId?: string,
): App {
  const app = new App({
    token: botToken,
    socketMode: true,
    appToken,
  });

  // 监听所有消息事件
  app.message(async ({ message }) => {
    // 类型断言：message 事件的具体结构
    const msg = message as Record<string, any>;

    if (!acceptSlackMessage(msg, dotBridge, selfUserId)) return;

    // 提取附件文件信息
    let files: SlackMessageData["files"];
    if (msg.files && Array.isArray(msg.files)) {
      files = msg.files.map((f: Record<string, any>) => ({
        url: f.url_private_download || f.url_private || "",
        name: f.name || f.title || "未知文件",
        mimetype: f.mimetype || "application/octet-stream",
      }));
    }

    // 构造标准消息数据
    const data: SlackMessageData = {
      channel: msg.channel as string,
      subtype: msg.subtype as string | undefined,
      messageTs: msg.ts as string,
      threadTs: msg.thread_ts as string | undefined,
      text: (msg.text as string) || "",
      userId: msg.user as string,
      botId: msg.bot_id as string | undefined,
      files,
    };

    console.log(`[SlackEvent] 收到消息: channel=${data.channel}, user=${data.userId}, ts=${data.messageTs}`);

    // 调用消息处理回调
    try {
      await onMessage(data);
    } catch (err) {
      console.error("[SlackEvent] 消息处理回调异常 (details redacted)");
    }
  });

  return app;
}

/** Only ordinary messages from the pinned dot identity may enter dot mode. */
export function acceptSlackMessage(
  msg: Record<string, any>, dot?: DotBridgeConfig, selfUserId?: string,
): boolean {
  if (dot) {
    if (!selfUserId || dot.botUserId === selfUserId || msg.user === selfUserId) return false;
    return msg.user === dot.botUserId && msg.bot_id === dot.botId &&
      (!msg.subtype || msg.subtype === "bot_message") &&
      typeof msg.thread_ts === "string" && msg.thread_ts !== msg.ts &&
      typeof msg.ts === "string" && typeof msg.channel === "string" &&
      typeof msg.text === "string";
  }
  return !msg.bot_id && !msg.subtype;
}
