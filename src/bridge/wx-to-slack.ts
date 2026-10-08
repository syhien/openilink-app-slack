import type { DotBridgeConfig } from "../config.js";
import { SlackClient } from "../slack/client.js";
import { Store } from "../store.js";
import type { HubEvent, Installation } from "../hub/types.js";

/**
 * 微信 → Slack 消息转发
 * 接收 Hub 推送的微信消息事件，转发到 Slack 频道
 */
export class WxToSlack {
  private slackClient: SlackClient;
  private store: Store;
  private defaultChannel: string;

  constructor(slackClient: SlackClient, store: Store, defaultChannel: string, private dot?: DotBridgeConfig) {
    this.slackClient = slackClient;
    this.store = store;
    this.defaultChannel = defaultChannel;
  }

  /**
   * 处理微信事件，转发到 Slack
   * @param event Hub 推送的事件
   * @param installation 安装记录
   */
  async handleWxEvent(event: HubEvent, installation: Installation): Promise<void> {
    const evt = event.event;
    if (!evt) {
      console.warn("[WxToSlack] 事件缺少 event 字段，跳过");
      return;
    }

    const eventType = evt.type;
    const data = evt.data;
    const rawName = data.from_name || data.fromName || "未知用户";
    const escape = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fromName = this.dot ? escape(rawName) : rawName;
    const fromId = data.from_id || data.fromId || "";

    if (this.dot) {
      // Fail closed for unrecognized senders, other installations and group messages.
      if (!this.defaultChannel || installation.id !== this.dot.installationId ||
          event.installation_id !== installation.id || fromId !== this.dot.wxOwnerId ||
          data.group || data.group_id || data.groupId || !evt.id ||
          !eventType.startsWith("message")) return;
      if (!this.store.claimBridgeDelivery(JSON.stringify(["wx", installation.id, evt.id]))) return;
    }
    console.log(`[WxToSlack] 处理微信事件: type=${eventType}`);

    let slackMessageTs: string | undefined;

    try {
      switch (eventType) {
        case "message.text":
        case "message": {
          // 文本消息 → 发送 Block Kit 消息
          const text = data.text || data.content || "";
          slackMessageTs = await this.sendTextBlock(fromName, text);
          break;
        }

        case "message.image": {
          // 图片消息
          const fallback = `[微信] ${fromName}: [发送了图片]`;
          slackMessageTs = await this.slackClient.sendText(this.defaultChannel, fallback);
          break;
        }

        case "message.voice": {
          // 语音消息
          const fallback = `[微信] ${fromName}: [语音消息]`;
          slackMessageTs = await this.slackClient.sendText(this.defaultChannel, fallback);
          break;
        }

        case "message.video": {
          // 视频消息
          const fallback = `[微信] ${fromName}: [视频消息]`;
          slackMessageTs = await this.slackClient.sendText(this.defaultChannel, fallback);
          break;
        }

        case "message.file": {
          // 文件消息
          const rawFileName = data.file_name || data.fileName || "未知文件";
          const fileName = this.dot ? escape(rawFileName) : rawFileName;
          const fallback = `[微信] ${fromName}: [文件: ${fileName}]`;
          slackMessageTs = await this.slackClient.sendText(this.defaultChannel, fallback);
          break;
        }

        case "command": {
          // 命令事件，跳过不转发
          console.log("[WxToSlack] 收到命令事件，跳过转发");
          return;
        }

        default: {
          // 未知消息类型
          const fallback = `[微信] ${fromName}: [${this.dot ? escape(eventType) : eventType}消息]`;
          slackMessageTs = await this.slackClient.sendText(this.defaultChannel, fallback);
          break;
        }
      }

      // 保存消息关联记录
      if (slackMessageTs && fromId) {
        this.store.saveMessageLink({
          installationId: installation.id,
          slackMessageTs,
          slackChannelId: this.defaultChannel,
          wxUserId: fromId,
          wxUserName: fromName,
        });
        console.log(`[WxToSlack] 保存消息关联: slackTs=${slackMessageTs}, wxUser=${fromId}`);
      }
    } catch (err) {
      console.error(`[WxToSlack] 转发微信消息失败: type=${eventType} (details redacted)`);
    }
  }

  /**
   * 发送带有 Block Kit 格式的文本消息
   * Section block 显示消息内容，Context block 显示来源
   *
   * @param fromName 发送者名称
   * @param text 消息内容
   * @returns Slack 消息时间戳
   */
  private async sendTextBlock(fromName: string, text: string): Promise<string> {
    if (this.dot) {
      if (typeof text !== "string" || !text.trim()) return "";
      const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // The bridge is visibly the sender; never impersonate the owner or dot.
      const forwarded = `<@${this.dot.botUserId}> [微信转发] ${escape(text)}`;
      return this.slackClient.sendBlocks(this.defaultChannel, [{
        type: "section", text: { type: "mrkdwn", text: forwarded },
      }], forwarded);
    }
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `来自微信 · ${fromName}`,
          },
        ],
      },
    ];

    const fallbackText = `[微信] ${fromName}: ${text}`;
    return this.slackClient.sendBlocks(this.defaultChannel, blocks, fallbackText);
  }
}
