import { WebClient } from "@slack/web-api";

/**
 * Slack SDK 封装
 * 基于 @slack/web-api 的 WebClient，提供常用消息操作
 */
export class SlackClient {
  /** 暴露原始 WebClient 供 tools 使用 */
  public web: WebClient;
  /** 默认频道 ID */
  private defaultChannel: string;

  constructor(botToken: string, defaultChannel?: string) {
    this.web = new WebClient(botToken);
    this.defaultChannel = defaultChannel ?? "";
  }

  /**
   * 解析频道参数，为空时使用默认频道
   */
  private resolveChannel(channel?: string): string {
    const ch = channel || this.defaultChannel;
    if (!ch) {
      throw new Error("未指定频道且未设置默认频道");
    }
    return ch;
  }

  /**
   * 发送文本消息
   * @param channel 频道 ID，为空时使用默认频道
   * @param text 文本内容
   * @param threadTs 线程时间戳，用于回复消息
   * @returns 消息时间戳（ts），作为消息 ID
   */
  async sendText(channel: string, text: string, threadTs?: string): Promise<string> {
    try {
      const ch = this.resolveChannel(channel);
      const result = await this.web.chat.postMessage({
        channel: ch,
        text,
        thread_ts: threadTs,
      });

      if (!result.ts) {
        throw new Error("发送消息成功但未返回 ts");
      }

      console.log(`[SlackClient] 发送文本消息成功: channel=${ch}, ts=${result.ts}`);
      return result.ts;
    } catch (err) {
      console.error("[SlackClient] 发送文本消息失败 (details redacted)");
      throw err;
    }
  }

  /**
   * 发送 Block Kit 消息
   * @param channel 频道 ID
   * @param blocks Block Kit 块数组
   * @param text 回退文本（不支持 Block Kit 时显示）
   * @param threadTs 线程时间戳
   * @returns 消息时间戳
   */
  async sendBlocks(
    channel: string,
    blocks: any[],
    text: string,
    threadTs?: string,
  ): Promise<string> {
    try {
      const ch = this.resolveChannel(channel);
      const result = await this.web.chat.postMessage({
        channel: ch,
        blocks,
        text,
        thread_ts: threadTs,
      });

      if (!result.ts) {
        throw new Error("发送 Block Kit 消息成功但未返回 ts");
      }

      console.log(`[SlackClient] 发送 Block Kit 消息成功: channel=${ch}, ts=${result.ts}`);
      return result.ts;
    } catch (err) {
      console.error("[SlackClient] 发送 Block Kit 消息失败 (details redacted)");
      throw err;
    }
  }

  /**
   * 回复消息（线程回复）
   * @param channel 频道 ID
   * @param threadTs 父消息时间戳
   * @param text 回复文本
   * @returns 回复消息的时间戳
   */
  async replyText(channel: string, threadTs: string, text: string): Promise<string> {
    return this.sendText(channel, text, threadTs);
  }

  /**
   * 上传文件到频道
   * @param channel 频道 ID
   * @param fileBuffer 文件内容
   * @param filename 文件名
   * @param title 文件标题（可选）
   */
  async uploadFile(
    channel: string,
    fileBuffer: Buffer,
    filename: string,
    title?: string,
  ): Promise<void> {
    try {
      const ch = this.resolveChannel(channel);
      await this.web.filesUploadV2({
        channel_id: ch,
        file: fileBuffer,
        filename,
        title: title ?? filename,
      });

      console.log(`[SlackClient] 上传文件成功: channel=${ch}, filename=${filename}`);
    } catch (err) {
      console.error("[SlackClient] 上传文件失败:", err);
      throw err;
    }
  }

  /**
   * 添加表情回应
   * @param channel 频道 ID
   * @param messageTs 目标消息时间戳
   * @param emoji 表情名称（不含冒号，如 "thumbsup"）
   */
  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    try {
      const ch = this.resolveChannel(channel);
      await this.web.reactions.add({
        channel: ch,
        timestamp: messageTs,
        name: emoji,
      });

      console.log(`[SlackClient] 添加表情成功: channel=${ch}, ts=${messageTs}, emoji=${emoji}`);
    } catch (err) {
      console.error("[SlackClient] 添加表情失败:", err);
      throw err;
    }
  }

  /**
   * 获取频道信息
   * @param channel 频道 ID
   * @returns 频道信息对象
   */
  async getChannelInfo(channel: string): Promise<any> {
    try {
      const ch = this.resolveChannel(channel);
      const result = await this.web.conversations.info({ channel: ch });

      console.log(`[SlackClient] 获取频道信息成功: channel=${ch}`);
      return result.channel;
    } catch (err) {
      console.error("[SlackClient] 获取频道信息失败:", err);
      throw err;
    }
  }

  /**
   * 获取频道消息历史
   * @param channel 频道 ID
   * @param limit 最大消息数量，默认 20
   * @returns 消息数组
   */
  async getMessages(channel: string, limit: number = 20): Promise<any[]> {
    try {
      const ch = this.resolveChannel(channel);
      const result = await this.web.conversations.history({
        channel: ch,
        limit,
      });

      console.log(`[SlackClient] 获取消息历史成功: channel=${ch}, count=${result.messages?.length ?? 0}`);
      return result.messages ?? [];
    } catch (err) {
      console.error("[SlackClient] 获取消息历史失败:", err);
      throw err;
    }
  }

  /**
   * 获取消息的回复（线程消息）
   * @param channel 频道 ID
   * @param threadTs 父消息时间戳
   * @returns 回复消息数组
   */
  async getReplies(channel: string, threadTs: string): Promise<any[]> {
    try {
      const ch = this.resolveChannel(channel);
      const result = await this.web.conversations.replies({
        channel: ch,
        ts: threadTs,
      });

      console.log(`[SlackClient] 获取消息回复成功: channel=${ch}, threadTs=${threadTs}, count=${result.messages?.length ?? 0}`);
      return result.messages ?? [];
    } catch (err) {
      console.error("[SlackClient] 获取消息回复失败:", err);
      throw err;
    }
  }

  // 搜索消息（需要 user token，bot token 不支持）
  // async searchMessages(query: string): Promise<any[]> { ... }
}
