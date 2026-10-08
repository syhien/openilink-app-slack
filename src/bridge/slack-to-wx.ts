import type { DotBridgeConfig } from "../config.js";
import { acceptSlackMessage } from "../slack/event.js";
import { Store } from "../store.js";
import { HubClient } from "../hub/client.js";
import type { Installation } from "../hub/types.js";
import type { SlackMessageData } from "../slack/event.js";

/**
 * Slack → 微信消息转发
 * 接收 Slack 频道消息，通过 Hub API 转发到微信用户
 */
export class SlackToWx {
  private store: Store;
  private defaultChannel: string;

  private selfUserId?: string;

  setSelfUserId(id: string): void { this.selfUserId = id; }

  constructor(store: Store, defaultChannel: string, private dot?: DotBridgeConfig) {
    this.store = store;
    this.defaultChannel = defaultChannel;
  }

  /**
   * 处理 Slack 消息，转发到微信
   * @param data Slack 消息数据
   * @param installations 所有安装记录，用于查找对应的 Hub 连接
   */
  async handleSlackMessage(
    data: SlackMessageData,
    installations: Installation[],
  ): Promise<void> {
    if (this.dot && (!this.defaultChannel || !acceptSlackMessage({
      user: data.userId, bot_id: data.botId, subtype: data.subtype, text: data.text,
      ts: data.messageTs, thread_ts: data.threadTs, channel: data.channel,
    }, this.dot, this.selfUserId))) return;
    // 忽略非目标频道的消息
    if (this.defaultChannel && data.channel !== this.defaultChannel) {
      console.log(`[SlackToWx] 忽略非目标频道消息: channel=${data.channel}`);
      return;
    }

    // 查找目标微信用户：通过 threadTs 在消息关联表中查找
    const threadTs = data.threadTs;
    if (!threadTs) {
      console.log("[SlackToWx] 消息不在线程中，无法确定目标微信用户，跳过");
      return;
    }

    // 根据线程的父消息 ts 查找消息关联，遍历所有安装实例
    let link: import("../hub/types.js").MessageLink | undefined;
    for (const inst of installations) {
      if (this.dot && inst.id !== this.dot.installationId) continue;
      link = this.store.getMessageLinkBySlack(data.channel, threadTs, inst.id);
      if (link) break;
    }
    if (!link) {
      console.log(`[SlackToWx] 未找到消息关联: channel=${data.channel}, threadTs=${threadTs}`);
      return;
    }

    if (this.dot && link.wxUserId !== this.dot.wxOwnerId) return;

    // 查找对应的安装记录
    const installation = installations.find((inst) => inst.id === link!.installationId);
    if (!installation) {
      console.warn(`[SlackToWx] 未找到安装记录: installationId=${link.installationId}`);
      return;
    }

    // 清理消息文本：去除 Slack @提及格式 <@U123456>
    const cleanText = this.cleanSlackMentions(data.text);

    if (!cleanText.trim()) {
      console.log("[SlackToWx] 清理后消息为空，跳过");
      return;
    }

    if (this.dot && !this.store.claimBridgeDelivery(JSON.stringify([
      "slack", installation.id, data.channel, data.messageTs,
    ]))) return;

    // 通过 HubClient 发送到微信
    try {
      const hubClient = new HubClient(installation.hubUrl, installation.appToken);
      await hubClient.sendText(link.wxUserId, cleanText);
      console.log(`[SlackToWx] 转发消息成功: wxUser=${link.wxUserId}`);
    } catch (err) {
      console.error("[SlackToWx] 转发消息到微信失败 (details redacted)");
    }
  }

  /**
   * 去除 Slack @提及格式
   * 将 <@U1234567890> 替换为空字符串
   *
   * @param text 原始消息文本
   * @returns 清理后的文本
   */
  private cleanSlackMentions(text: string): string {
    return text.replace(/<@[A-Z0-9]+>/g, "").trim();
  }
}
