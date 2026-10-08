import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Installation, MessageLink } from "./hub/types.js";
import { encryptConfig, decryptConfig } from "./utils/config-crypto.js";

const BRIDGE_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BRIDGE_DELIVERY_MAX_ENTRIES = 10_000;

/**
 * SQLite 存储层
 * 使用 better-sqlite3 同步 API
 */
export class Store {
  private db: Database.Database;
  private claimDeliveryTransaction: Database.Transaction<(keyHash: string, now: number) => boolean>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // 启用 WAL 模式提升并发性能
    this.db.pragma("journal_mode = WAL");
    this.initTables();

    const deleteExpired = this.db.prepare("DELETE FROM bridge_deliveries WHERE claimed_at <= ?");
    const insertClaim = this.db.prepare(`
      INSERT INTO bridge_deliveries (key_hash, claimed_at)
      SELECT ?, ?
      WHERE (SELECT COUNT(*) FROM bridge_deliveries) < ?
      ON CONFLICT(key_hash) DO NOTHING
    `);
    this.claimDeliveryTransaction = this.db.transaction((keyHash: string, now: number) => {
      deleteExpired.run(now - BRIDGE_DELIVERY_TTL_MS);
      return insertClaim.run(keyHash, now, BRIDGE_DELIVERY_MAX_ENTRIES).changes === 1;
    });
  }

  /** 初始化数据库表 */
  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        id TEXT PRIMARY KEY,
        hub_url TEXT NOT NULL,
        app_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        app_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS message_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        slack_message_ts TEXT NOT NULL,
        slack_channel_id TEXT NOT NULL,
        wx_user_id TEXT NOT NULL,
        wx_user_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_links_slack_ts
        ON message_links(slack_channel_id, slack_message_ts);
      CREATE INDEX IF NOT EXISTS idx_message_links_wx_user
        ON message_links(installation_id, wx_user_id);

      CREATE TABLE IF NOT EXISTS bridge_deliveries (
        key_hash TEXT PRIMARY KEY,
        claimed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_deliveries_claimed_at
        ON bridge_deliveries(claimed_at);
    `);

    // 兼容旧库：为 installations 表添加 encrypted_config 列
    try {
      this.db.exec(`ALTER TABLE installations ADD COLUMN encrypted_config TEXT NOT NULL DEFAULT ''`);
    } catch {
      // 列已存在则忽略
    }
  }

  /**
   * Claim a delivery before any network side effect. A true result permits one
   * attempt, not a guaranteed delivery: never release the claim after failure,
   * since a timeout or crash may hide an already completed remote send.
   *
   * Claims survive restarts for seven days. At capacity, fail closed rather
   * than evicting a live claim and allowing its delivery to be repeated.
   * SQLite failures propagate, so callers must not send unless this returns true.
   */
  claimBridgeDelivery(key: string, now = Date.now()): boolean {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("Bridge delivery claim time must be a non-negative integer");
    }
    const keyHash = createHash("sha256").update(key).digest("hex");

    // BEGIN IMMEDIATE serializes cleanup, capacity checks and insertion across
    // independent Store instances and processes, not just this JS event loop.
    return this.claimDeliveryTransaction.immediate(keyHash, now);
  }

  // ========== Installation CRUD ==========

  /** 保存安装记录（upsert） */
  saveInstallation(inst: Installation): void {
    const stmt = this.db.prepare(`
      INSERT INTO installations (id, hub_url, app_id, bot_id, app_token, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        hub_url = excluded.hub_url,
        app_id = excluded.app_id,
        bot_id = excluded.bot_id,
        app_token = excluded.app_token,
        webhook_secret = excluded.webhook_secret
    `);
    stmt.run(inst.id, inst.hubUrl, inst.appId, inst.botId, inst.appToken, inst.webhookSecret);
  }

  /** 根据 ID 获取安装记录 */
  getInstallation(id: string): Installation | undefined {
    const row = this.db.prepare("SELECT * FROM installations WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      hubUrl: row.hub_url,
      appId: row.app_id,
      botId: row.bot_id,
      appToken: row.app_token,
      webhookSecret: row.webhook_secret,
      createdAt: row.created_at,
    };
  }

  /** 获取所有安装记录 */
  getAllInstallations(): Installation[] {
    const rows = this.db.prepare("SELECT * FROM installations").all() as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id,
      hubUrl: row.hub_url,
      appId: row.app_id,
      botId: row.bot_id,
      appToken: row.app_token,
      webhookSecret: row.webhook_secret,
      createdAt: row.created_at,
    }));
  }

  /** 删除安装记录 */
  deleteInstallation(id: string): void {
    this.db.prepare("DELETE FROM installations WHERE id = ?").run(id);
  }

  // ========== 用户配置（加密存储） ==========

  /** 保存用户配置（AES-256-GCM 加密后存储） */
  saveConfig(installationId: string, config: Record<string, string>): void {
    const encrypted = encryptConfig(JSON.stringify(config));
    this.db
      .prepare(`UPDATE installations SET encrypted_config = ? WHERE id = ?`)
      .run(encrypted, installationId);
  }

  /** 读取用户配置（从本地解密） */
  getConfig(installationId: string): Record<string, string> {
    const row = this.db
      .prepare("SELECT encrypted_config FROM installations WHERE id = ?")
      .get(installationId) as { encrypted_config?: string } | undefined;
    if (!row?.encrypted_config) return {};
    try {
      return JSON.parse(decryptConfig(row.encrypted_config)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  // ========== MessageLink CRUD ==========

  /** 保存消息关联 */
  saveMessageLink(link: MessageLink): number {
    const stmt = this.db.prepare(`
      INSERT INTO message_links (installation_id, slack_message_ts, slack_channel_id, wx_user_id, wx_user_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      link.installationId,
      link.slackMessageTs,
      link.slackChannelId,
      link.wxUserId,
      link.wxUserName,
    );
    return Number(result.lastInsertRowid);
  }

  /** 根据 Slack 消息时间戳、频道和安装实例 ID 查找关联 */
  getMessageLinkBySlack(channelId: string, messageTs: string, installationId: string): MessageLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM message_links WHERE slack_channel_id = ? AND slack_message_ts = ? AND installation_id = ?")
      .get(channelId, messageTs, installationId) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.rowToMessageLink(row);
  }

  /** 根据微信用户 ID 查找最近的消息关联 */
  getLatestMessageLinkByWxUser(installationId: string, wxUserId: string): MessageLink | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM message_links WHERE installation_id = ? AND wx_user_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(installationId, wxUserId) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.rowToMessageLink(row);
  }

  /** 根据 ID 获取消息关联 */
  getMessageLink(id: number): MessageLink | undefined {
    const row = this.db.prepare("SELECT * FROM message_links WHERE id = ?").get(id) as
      | Record<string, any>
      | undefined;
    if (!row) return undefined;
    return this.rowToMessageLink(row);
  }

  /** 删除消息关联 */
  deleteMessageLink(id: number): void {
    this.db.prepare("DELETE FROM message_links WHERE id = ?").run(id);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  /** 将数据库行转换为 MessageLink 对象 */
  private rowToMessageLink(row: Record<string, any>): MessageLink {
    return {
      id: row.id,
      installationId: row.installation_id,
      slackMessageTs: row.slack_message_ts,
      slackChannelId: row.slack_channel_id,
      wxUserId: row.wx_user_id,
      wxUserName: row.wx_user_name,
      createdAt: row.created_at,
    };
  }
}
