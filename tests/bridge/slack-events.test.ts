import { describe, expect, it, vi } from "vitest";
const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@slack/bolt", () => ({ App: class { message = register; } }));
import { createSlackApp } from "../../src/slack/event.js";
const dot = { botId: "BDOT", botUserId: "UDOT", wxOwnerId: "owner", installationId: "inst" };
describe("registered Socket Mode message listener", () => {
  it("passes the pinned bot reply identity and subtype to the bridge", async () => {
    const callback = vi.fn();
    createSlackApp("unused", "unused", callback, dot, "UBRIDGE");
    const listener = register.mock.calls.at(-1)![0];
    const message = { user: "UDOT", bot_id: "BDOT", subtype: "bot_message", channel: "CPRIVATE", ts: "2.0", thread_ts: "1.0", text: "answer" };
    await listener({ message });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ botId: "BDOT", userId: "UDOT", subtype: "bot_message", threadTs: "1.0" }));
    await listener({ message: { ...message, subtype: "message_changed" } });
    await listener({ message: { ...message, user: "UBRIDGE" } });
    await listener({ message: { ...message, bot_id: "BOTHER" } });
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("keeps original bot exclusion when mode is disabled", async () => {
    const callback = vi.fn(); createSlackApp("unused", "unused", callback);
    const listener = register.mock.calls.at(-1)![0];
    await listener({ message: { bot_id: "BDOT", text: "answer" } });
    expect(callback).not.toHaveBeenCalled();
    await listener({ message: { user: "UHUMAN", channel: "CPRIVATE", ts: "2.0", text: "hello" } });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
