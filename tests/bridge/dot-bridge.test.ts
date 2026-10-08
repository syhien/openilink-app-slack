import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store.js";
import { WxToSlack } from "../../src/bridge/wx-to-slack.js";
import { SlackToWx } from "../../src/bridge/slack-to-wx.js";
import { acceptSlackMessage } from "../../src/slack/event.js";
import { HubClient } from "../../src/hub/client.js";
import { loadConfig, type DotBridgeConfig } from "../../src/config.js";
import type { HubEvent, Installation } from "../../src/hub/types.js";
import type { SlackClient } from "../../src/slack/client.js";

const dot: DotBridgeConfig = { botId: "BDOT", botUserId: "UDOT", wxOwnerId: "owner", installationId: "inst" };
const inst: Installation = { id: "inst", hubUrl: "https://unused.invalid", appId: "app", botId: "wxbot", appToken: "test", webhookSecret: "test" };
const raw = { user: "UDOT", bot_id: "BDOT", text: "answer", channel: "CPRIVATE", ts: "2.0", thread_ts: "1.0" };
const event = (id = "evt"): HubEvent => ({ v: 1, type: "event", trace_id: "trace", installation_id: "inst", bot: { id: "wxbot" }, event: { id, type: "message.text", timestamp: 1, data: { from_id: "owner", from_name: "Owner", text: "hello" } } });
const reply = () => ({ userId: "UDOT", botId: "BDOT", text: "answer", channel: "CPRIVATE", messageTs: "2.0", threadTs: "1.0" });
let store: Store;
let slack: { sendBlocks: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> };
beforeEach(() => { store = new Store(":memory:"); store.saveInstallation(inst); slack = { sendBlocks: vi.fn().mockResolvedValue("1.0"), sendText: vi.fn().mockResolvedValue("1.0") }; });
afterEach(() => { store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function incoming() { return new WxToSlack(slack as unknown as SlackClient, store, "CPRIVATE", dot); }
function outgoing() { const b = new SlackToWx(store, "CPRIVATE", dot); b.setSelfUserId("UBRIDGE"); return b; }
function map(owner = "owner") { store.saveMessageLink({ installationId: "inst", slackChannelId: "CPRIVATE", slackMessageTs: "1.0", wxUserId: owner, wxUserName: "Owner" }); }

describe("dot event boundary", () => {
  it("accepts only the exact bot/user pair and ordinary replies", () => {
    expect(acceptSlackMessage(raw, dot, "UBRIDGE")).toBe(true);
    expect(acceptSlackMessage({ ...raw, subtype: "bot_message" }, dot, "UBRIDGE")).toBe(true);
    for (const patch of [{ user: "UOTHER" }, { bot_id: "BOTHER" }, { bot_id: undefined }, { user: "UBRIDGE" }, { subtype: "message_changed" }, { subtype: "message_deleted" }, { subtype: "thread_broadcast" }, { thread_ts: undefined }, { thread_ts: "2.0" }, { text: undefined }]) {
      expect(acceptSlackMessage({ ...raw, ...patch }, dot, "UBRIDGE")).toBe(false);
    }
    expect(acceptSlackMessage(raw, dot)).toBe(false);
    expect(acceptSlackMessage(raw, dot, "UDOT")).toBe(false);
  });
  it("preserves disabled-mode bot/subtype filtering", () => {
    expect(acceptSlackMessage(raw)).toBe(false);
    expect(acceptSlackMessage({ user: "UHUMAN", text: "hi" })).toBe(true);
    expect(acceptSlackMessage({ user: "UHUMAN", subtype: "message_changed" })).toBe(false);
  });
});

describe("real bridge classes with mocked transports", () => {
  it("mentions dot in text and blocks, escaping owner-supplied mentions", async () => {
    const e = event(); e.event!.data.text = "hello <@UOTHER> & <!channel>";
    await incoming().handleWxEvent(e, inst);
    const [channel, blocks, text] = slack.sendBlocks.mock.calls[0];
    expect(channel).toBe("CPRIVATE");
    expect(text).toBe("<@UDOT> [微信转发] hello &lt;@UOTHER&gt; &amp; &lt;!channel&gt;");
    expect(blocks[0].text.text).toBe(text);
    expect(store.getMessageLinkBySlack("CPRIVATE", "1.0", "inst")?.wxUserId).toBe("owner");
  });
  it("blocks other owners, installations, group messages and missing event IDs", async () => {
    const bridge = incoming();
    for (const patch of [{ from_id: "other" }, { group: { id: "group" } }, { group_id: "group" }]) {
      const e = event(); Object.assign(e.event!.data, patch); await bridge.handleWxEvent(e, inst);
    }
    await bridge.handleWxEvent(event(), { ...inst, id: "other" });
    await bridge.handleWxEvent({ ...event(), installation_id: "other" }, inst);
    await bridge.handleWxEvent(event(""), inst);
    expect(slack.sendBlocks).not.toHaveBeenCalled();
  });
  it("claims before send, suppresses concurrent duplicates and ambiguous failures", async () => {
    const bridge = incoming();
    slack.sendBlocks.mockRejectedValue(new Error("secret body"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all([bridge.handleWxEvent(event(), inst), bridge.handleWxEvent(event(), inst)]);
    await bridge.handleWxEvent(event(), inst);
    expect(slack.sendBlocks).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret body");
  });
  it("sends only mapped channel replies to the pinned owner, once", async () => {
    map(); const send = vi.spyOn(HubClient.prototype, "sendText").mockResolvedValue();
    const bridge = outgoing();
    await Promise.all([bridge.handleSlackMessage(reply(), [inst]), bridge.handleSlackMessage(reply(), [inst])]);
    expect(send).toHaveBeenCalledExactlyOnceWith("owner", "answer");
  });
  it("does not leak success or failure message bodies into bridge logs", async () => {
    map(); const send = vi.spyOn(HubClient.prototype, "sendText").mockResolvedValue();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await outgoing().handleSlackMessage({ ...reply(), text: "private-body" }, [inst]);
    send.mockRejectedValue(new Error("private-body"));
    await outgoing().handleSlackMessage({ ...reply(), messageTs: "3.0", text: "private-body" }, [inst]);
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain("private-body");
  });
  it("rejects human/other-bot replies, unthreaded/unmapped/cross-channel traffic", async () => {
    map(); const send = vi.spyOn(HubClient.prototype, "sendText").mockResolvedValue();
    for (const patch of [{ userId: "UHUMAN", botId: undefined }, { botId: "BOTHER" }, { channel: "COTHER" }, { threadTs: undefined }, { threadTs: "unknown" }, { subtype: "message_changed" }]) {
      await outgoing().handleSlackMessage({ ...reply(), ...patch }, [inst]);
    }
    await outgoing().handleSlackMessage(reply(), [{ ...inst, id: "other" }]);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a mapped non-owner and missing runtime self identity", async () => {
    map("other"); const send = vi.spyOn(HubClient.prototype, "sendText").mockResolvedValue();
    await outgoing().handleSlackMessage(reply(), [inst]);
    await new SlackToWx(store, "CPRIVATE", dot).handleSlackMessage(reply(), [inst]);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps legacy human reply behavior when disabled", async () => {
    map(); const send = vi.spyOn(HubClient.prototype, "sendText").mockResolvedValue();
    await new SlackToWx(store, "CPRIVATE").handleSlackMessage({ ...reply(), userId: "UHUMAN", botId: undefined }, [inst]);
    expect(send).toHaveBeenCalledExactlyOnceWith("owner", "answer");
    await new WxToSlack(slack as unknown as SlackClient, store, "CPRIVATE").handleWxEvent(event(), inst);
    expect(slack.sendBlocks.mock.calls[0][2]).not.toContain("<@UDOT>");
  });
});

describe("opt-in configuration", () => {
  function env() {
    for (const [key, value] of Object.entries({ HUB_URL: "https://hub.invalid", BASE_URL: "https://app.invalid", DOT_BRIDGE_ENABLED: "true", DOT_SLACK_USER_ID: "UDOT", DOT_SLACK_BOT_ID: "BDOT", DOT_WECHAT_OWNER_ID: "owner", DOT_INSTALLATION_ID: "inst", SLACK_CHANNEL_ID: "CPRIVATE", SLACK_BOT_TOKEN: "test", SLACK_APP_TOKEN: "test" })) vi.stubEnv(key, value);
  }
  it("requires every explicit pin and credential", () => {
    env(); expect(loadConfig().dotBridge).toEqual(dot);
    for (const key of ["DOT_SLACK_USER_ID", "DOT_SLACK_BOT_ID", "DOT_WECHAT_OWNER_ID", "DOT_INSTALLATION_ID", "SLACK_CHANNEL_ID", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
      env(); vi.stubEnv(key, ""); expect(() => loadConfig()).toThrow(key);
    }
  });
  it("rejects invalid opt-in values/Slack IDs and stays off by default", () => {
    env(); vi.stubEnv("DOT_SLACK_USER_ID", "<@UDOT>"); expect(() => loadConfig()).toThrow("Invalid dot");
    env(); vi.stubEnv("DOT_BRIDGE_ENABLED", "tru"); expect(() => loadConfig()).toThrow("true or false");
    vi.stubEnv("DOT_BRIDGE_ENABLED", undefined); expect(loadConfig().dotBridge).toBeUndefined();
  });
});
