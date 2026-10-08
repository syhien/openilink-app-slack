import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { handleOAuthSetup, handleOAuthRedirect, handleOAuthNotify, cleanExpired } from "./hub/oauth.js";
import { handleSettingsPage, handleSettingsVerify, handleSettingsSave } from "./hub/settings.js";
import { handleWebhook } from "./hub/webhook.js";
import { getManifest } from "./hub/manifest.js";
import { HubClient } from "./hub/client.js";
import { Router } from "./router.js";
import { SlackClient } from "./slack/client.js";
import { createSlackApp, type SlackMessageData } from "./slack/event.js";
import { collectAllTools } from "./tools/index.js";
import { WxToSlack } from "./bridge/wx-to-slack.js";
import { SlackToWx } from "./bridge/slack-to-wx.js";

/** 按 installation_id 缓存的 per-installation Slack 客户端 */
const slackClientCache = new Map<string, SlackClient>();

/** 获取或创建 per-installation 的 Slack 客户端 */
function getOrCreateSlackClient(
  installationId: string,
  botToken: string,
  channelId: string,
  defaultClient: SlackClient | null,
): SlackClient {
  // 如果没有 installationId 且有默认客户端，直接复用
  if (!installationId && defaultClient) return defaultClient;
  const cached = slackClientCache.get(installationId);
  if (cached) return cached;
  // 如果有凭证则创建新客户端并缓存
  if (botToken) {
    const client = new SlackClient(botToken, channelId);
    slackClientCache.set(installationId, client);
    console.log(`[Server] 为安装 ${installationId} 创建了独立的 Slack 客户端`);
    return client;
  }
  // 兜底：使用默认客户端
  if (defaultClient) return defaultClient;
  throw new Error(`[Server] 安装 ${installationId} 缺少 Slack 凭证且无默认客户端`);
}

/** 启动服务 */
async function main(): Promise<void> {
  const config = loadConfig();

  // 确保数据库目录存在
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const store = new Store(config.dbPath);

  // 初始化 Slack 客户端（如果环境变量中配置了 Slack 凭证）
  const hasSlackCredentials = !!(config.slackBotToken && config.slackAppToken);
  const slackClient = hasSlackCredentials
    ? new SlackClient(config.slackBotToken, config.slackChannelId)
    : null;
  if (slackClient) {
    console.log("[Server] Slack 客户端初始化完成");
  } else {
    console.log("[Server] 未配置 Slack 凭证，跳过默认 Slack 客户端初始化（云端托管模式，用户安装时填写）");
  }

  // 收集所有 Tool 定义和 Handler（需要一个 WebClient 实例来获取定义，如果没有默认客户端则用空凭证的客户端仅收集定义）
  const toolsSdkClient = slackClient ?? new SlackClient("", "");
  const { definitions, handlers } = collectAllTools(toolsSdkClient.web);

  // 初始化命令路由器
  const router = new Router(handlers);

  // 初始化消息桥接（如果有默认 Slack 客户端才启用）
  const wxToSlack = slackClient ? new WxToSlack(slackClient, store, config.slackChannelId, config.dotBridge) : null;
  const slackToWx = slackClient ? new SlackToWx(store, config.slackChannelId, config.dotBridge) : null;

  // 创建 Slack Bolt App（Socket Mode，仅在配置了 Slack 凭证时启动）
  let slackApp: Awaited<ReturnType<typeof createSlackApp>> | null = null;
  if (hasSlackCredentials && slackToWx) {
    const _slackToWx = slackToWx;
    let selfUserId: string | undefined;
    if (config.dotBridge) {
      const identity = await slackClient!.web.auth.test().catch(() => {
        throw new Error("Bridge identity verification failed (details redacted)");
      });
      selfUserId = identity.user_id;
      if (!selfUserId || selfUserId === config.dotBridge.botUserId || identity.bot_id === config.dotBridge.botId) {
        throw new Error("Cannot establish a distinct bridge bot identity");
      }
      _slackToWx.setSelfUserId(selfUserId);
    }
    slackApp = createSlackApp(
      config.slackBotToken,
      config.slackAppToken,
      async (data: SlackMessageData) => {
        // Slack 消息回调：将 Slack 回复转发回微信
        const installations = store.getAllInstallations();
        await _slackToWx.handleSlackMessage(data, installations);
      },
      config.dotBridge,
      selfUserId,
    );
  } else {
    console.log("[Server] 未配置 Slack 凭证，跳过 Socket Mode 连接");
  }

  // 定期清理过期的 PKCE 缓存
  const cleanupTimer = setInterval(cleanExpired, 60_000);

  // 创建 HTTP 服务器
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", config.baseUrl);
    const path = url.pathname;

    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Timestamp, X-Signature",
      });
      res.end();
      return;
    }

    try {
      // 健康检查
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
        return;
      }

      // Manifest
      if (path === "/manifest.json" && req.method === "GET") {
        const manifest = getManifest(config, definitions);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(manifest));
        return;
      }

      // GET/POST /oauth/setup - OAuth 安装流程（显示配置表单 / 提交后跳转授权）
      if (path === "/oauth/setup" && (req.method === "GET" || req.method === "POST")) {
        await handleOAuthSetup(req, res, config);
        return;
      }

      // GET /oauth/redirect - OAuth 回调（模式 1）
      // POST /oauth/redirect - Hub 直接安装通知（模式 2）
      if (path === "/oauth/redirect") {
        if (req.method === "POST") {
          await handleOAuthNotify(req, res, config, store, definitions);
          return;
        }
        if (req.method === "GET") {
          await handleOAuthRedirect(req, res, config, store, definitions);
          return;
        }
      }

      // GET /settings — 设置页面（输入 token 验证身份）
      if (req.method === "GET" && path === "/settings") {
        handleSettingsPage(req, res);
        return;
      }

      // POST /settings/verify — 验证 token 后显示配置表单
      if (req.method === "POST" && path === "/settings/verify") {
        await handleSettingsVerify(req, res, config, store);
        return;
      }

      // POST /settings/save — 保存修改后的配置
      if (req.method === "POST" && path === "/settings/save") {
        await handleSettingsSave(req, res, config, store);
        return;
      }

      // Hub Webhook - command 事件支持同步/异步响应
      if (path === "/hub/webhook" && req.method === "POST") {
        await handleWebhook(req, res, store, {
          // 命令事件 - 路由到 tool handler
          onCommand: async (event, installation) => {
            if (!event.event) return null;
            // 读取本地加密存储的用户配置，优先于环境变量
            const userCfg = store.getConfig(installation.id);
            const botToken = userCfg.slack_bot_token || config.slackBotToken;
            const channelId = userCfg.slack_channel_id || config.slackChannelId;

            // 如果用户有自定义凭证，使用 per-installation 缓存客户端
            const instSlackClient = getOrCreateSlackClient(
              installation.id, botToken, channelId, slackClient,
            );

            // 用当前安装对应的 Slack WebClient 重新收集 tools handlers
            const { handlers: instHandlers } = collectAllTools(instSlackClient.web);
            const instRouter = new Router(instHandlers);

            const hubClient = new HubClient(installation.hubUrl, installation.appToken);
            return instRouter.handleCommand(event, installation, hubClient);
          },
          // 非命令事件（消息桥接等）
          onEvent: async (event, installation) => {
            if (!event.event) return;
            if (event.event.type.startsWith("message") && wxToSlack) {
              await wxToSlack.handleWxEvent(event, installation);
            }
          },
          // 异步推送回调 - 命令超时后通过 Bot API 推送结果
          onAsyncPush: async (result, event, installation) => {
            const hubClient = new HubClient(installation.hubUrl, installation.appToken);
            const data = event.event?.data ?? {};
            const to = ((data as Record<string, any>).group?.id ?? (data as Record<string, any>).sender?.id ?? (data as Record<string, any>).user_id ?? (data as Record<string, any>).from ?? "") as string;
            if (!to) return;
            const traceId = event.trace_id;
            try {
              if (typeof result === "string") {
                await hubClient.sendText(to, result, traceId);
              } else {
                await hubClient.sendMessage(to, result.type ?? "text", result.reply, {
                  url: result.url,
                  base64: result.base64,
                  filename: result.name,
                  traceId,
                });
              }
            } catch (err) {
              console.error("[Server] 异步推送命令结果失败:", err);
            }
          },
        });
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err) {
      console.error("[Server] 请求处理异常:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  });

  // 启动 Slack Socket Mode（仅在配置了 Slack 凭证时启动）
  if (slackApp) {
    await slackApp.start();
    console.log("[Slack] Socket Mode 已连接");
  }

  // 启动 HTTP 服务
  server.listen(Number(config.port), () => {
    console.log(`[Server] Slack Bridge 已启动，监听端口 ${config.port}`);
    console.log(`[Server] Manifest: ${config.baseUrl}/manifest.json`);
    console.log(`[Server] Webhook: ${config.baseUrl}/hub/webhook`);
    console.log(`[Server] Health: ${config.baseUrl}/health`);
  });

  // 优雅关闭
  function shutdown(signal: string): void {
    console.log(`[Server] 收到 ${signal} 信号，开始优雅关闭...`);

    clearInterval(cleanupTimer);

    // 并行关闭所有服务
    const tasks: Promise<void>[] = [];
    if (slackApp) {
      tasks.push(slackApp.stop().then(() => {}).catch((err: unknown) => console.error("[Slack] 关闭失败:", err)));
    }
    tasks.push(new Promise<void>((resolve) => {
      server.close(() => resolve());
    }));

    Promise.all(tasks)
      .then(() => {
        store.close();
        console.log("[Server] 已优雅关闭");
        process.exit(0);
      })
      .catch((err) => {
        console.error("[Server] 关闭异常:", err);
        process.exit(1);
      });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Server] 启动失败:", err);
  process.exit(1);
});
