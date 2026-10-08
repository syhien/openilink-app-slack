import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Store } from "../../src/store.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const NOW = 1_800_000_000_000;

describe("persistent bridge delivery claims", () => {
  let directory: string;
  let dbPath: string;
  const stores = new Set<Store>();

  function openStore(): Store {
    const store = new Store(dbPath);
    stores.add(store);
    return store;
  }

  function closeStore(store: Store): void {
    store.close();
    stores.delete(store);
  }

  function inspectClaims(): { key_hash: string; claimed_at: number }[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare("SELECT key_hash, claimed_at FROM bridge_deliveries").all() as
        { key_hash: string; claimed_at: number }[];
    } finally {
      db.close();
    }
  }

  /** Real separate processes rendezvous before claiming through the public API. */
  async function concurrentClaims(keysByProcess: string[][], now: number): Promise<boolean[][]> {
    const sourceUrl = new URL("../../src/store.ts", import.meta.url).href;
    const workers = keysByProcess.map((keys) => {
      const script = `
        import { Store } from ${JSON.stringify(sourceUrl)};
        const store = new Store(${JSON.stringify(dbPath)});
        process.once("message", () => {
          try {
            const results = ${JSON.stringify(keys)}.map(key => store.claimBridgeDelivery(key, ${now}));
            process.send({ results });
          } finally {
            store.close();
            process.disconnect();
          }
        });
        process.send({ ready: true });
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        timeout: 15_000,
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const ready = new Promise<void>((resolve, reject) => {
        child.on("message", (message: { ready?: boolean }) => {
          if (message.ready) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Claim process exited before ready: ${stderr}`)));
      });
      const complete = new Promise<boolean[]>((resolve, reject) => {
        let results: boolean[] | undefined;
        child.on("message", (message: { results?: boolean[] }) => {
          if (message.results) results = message.results;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0 && results) resolve(results);
          else reject(new Error(`Claim process failed (${code}): ${stderr}`));
        });
      });
      return { child, ready, complete };
    });
    try {
      const [, results] = await Promise.all([
        Promise.all(workers.map((worker) => worker.ready)).then(() => {
          for (const worker of workers) worker.child.send("claim");
        }),
        Promise.all(workers.map((worker) => worker.complete)),
      ]);
      return results;
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null) worker.child.kill();
      }
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openilink-bridge-dedup-"));
    dbPath = join(directory, "store.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.clear();
    rmSync(directory, { recursive: true, force: true });
  });

  it("claims each distinct key once and stores only its hash", () => {
    const store = openStore();
    const firstKey = "wx-to-slack:installation-1:message-1";
    expect(store.claimBridgeDelivery(firstKey, NOW)).toBe(true);
    expect(store.claimBridgeDelivery(firstKey, NOW)).toBe(false);
    expect(store.claimBridgeDelivery("wx-to-slack:installation-2:message-1", NOW)).toBe(true);
    expect(store.claimBridgeDelivery("slack-to-wx:installation-1:message-1", NOW)).toBe(true);
    expect(store.claimBridgeDelivery("wx-to-slack:installation-1:message-2", NOW)).toBe(true);
    const claims = inspectClaims();
    expect(claims).toHaveLength(4);
    expect(claims).toContainEqual({
      key_hash: createHash("sha256").update(firstKey).digest("hex"),
      claimed_at: NOW,
    });
    expect(claims.every((claim) => /^[a-f0-9]{64}$/.test(claim.key_hash))).toBe(true);
  });

  it("shares claims across Store connections and persists them after reopening", () => {
    const first = openStore();
    const second = openStore();
    expect(first.claimBridgeDelivery("delivery", NOW)).toBe(true);
    expect(second.claimBridgeDelivery("delivery", NOW)).toBe(false);
    closeStore(first);
    closeStore(second);
    expect(openStore().claimBridgeDelivery("delivery", NOW + 1)).toBe(false);
  });

  it("adds the claim table to existing databases without disturbing their data", () => {
    const original = openStore();
    original.saveInstallation({
      id: "existing-installation",
      hubUrl: "https://hub.example.com",
      appId: "app",
      botId: "bot",
      appToken: "test-token",
      webhookSecret: "test-secret",
    });
    closeStore(original);
    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE bridge_deliveries");
    legacy.close();

    const migrated = openStore();
    expect(migrated.getInstallation("existing-installation")?.appId).toBe("app");
    expect(migrated.claimBridgeDelivery("delivery", NOW)).toBe(true);
  });

  it("retains claims after a failed or ambiguously completed delivery", async () => {
    const store = openStore();
    const send = vi.fn().mockRejectedValue(new Error("timeout after remote acceptance"));
    async function attempt() {
      if (store.claimBridgeDelivery("delivery", NOW)) await send();
    }
    await expect(attempt()).rejects.toThrow("timeout");
    await expect(attempt()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    closeStore(store);
    expect(openStore().claimBridgeDelivery("delivery", NOW + 1)).toBe(false);
  });

  it("expires at seven days without extending TTL on duplicate attempts", () => {
    const store = openStore();
    expect(store.claimBridgeDelivery("delivery", NOW)).toBe(true);
    expect(store.claimBridgeDelivery("delivery", NOW + TTL_MS - 1)).toBe(false);
    expect(store.claimBridgeDelivery("delivery", NOW + TTL_MS)).toBe(true);
    expect(store.claimBridgeDelivery("delivery", NOW + TTL_MS + 1)).toBe(false);
  });

  it("removes expired claims on a claim for a different key", () => {
    const store = openStore();
    expect(store.claimBridgeDelivery("expired", NOW)).toBe(true);
    expect(store.claimBridgeDelivery("recent", NOW + 1)).toBe(true);
    expect(store.claimBridgeDelivery("new", NOW + TTL_MS)).toBe(true);
    expect(inspectClaims()).toHaveLength(2);
    expect(store.claimBridgeDelivery("recent", NOW + TTL_MS)).toBe(false);
  });

  it("uses the current time when omitted and rejects invalid times without deleting claims", () => {
    const store = openStore();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(store.claimBridgeDelivery("delivery")).toBe(true);
    expect(inspectClaims()[0].claimed_at).toBe(NOW);
    for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.claimBridgeDelivery("delivery", invalid)).toThrow(RangeError);
    }
    expect(store.claimBridgeDelivery("delivery", NOW)).toBe(false);
  });

  it("never evicts live claims at capacity and reuses only expired capacity", () => {
    const store = openStore();
    const claims = [];
    for (let index = 0; index < MAX_ENTRIES; index++) {
      claims.push(store.claimBridgeDelivery(`delivery-${index}`, NOW + index));
    }
    expect(claims.every(Boolean)).toBe(true);
    expect(store.claimBridgeDelivery("overflow", NOW + MAX_ENTRIES)).toBe(false);
    expect(store.claimBridgeDelivery("delivery-0", NOW + MAX_ENTRIES)).toBe(false);
    expect(store.claimBridgeDelivery(`delivery-${MAX_ENTRIES - 1}`, NOW + MAX_ENTRIES)).toBe(false);
    expect(inspectClaims()).toHaveLength(MAX_ENTRIES);

    // Exactly the oldest claim has expired. The previously rejected key can
    // now occupy that single slot, while every other original claim is kept.
    expect(store.claimBridgeDelivery("overflow", NOW + TTL_MS)).toBe(true);
    expect(store.claimBridgeDelivery("delivery-1", NOW + TTL_MS)).toBe(false);
    expect(store.claimBridgeDelivery("another-overflow", NOW + TTL_MS)).toBe(false);
    expect(inspectClaims()).toHaveLength(MAX_ENTRIES);
  }, 20_000);

  it("allows exactly one winner per key across concurrent processes", async () => {
    openStore();
    const keys = Array.from({ length: 20 }, (_, index) => `contended-${index}`);
    const results = await concurrentClaims([keys, keys, keys, keys], NOW);
    for (let index = 0; index < keys.length; index++) {
      expect(results.filter((result) => result[index])).toHaveLength(1);
    }
    expect(inspectClaims()).toHaveLength(keys.length);
  }, 20_000);

  it("serializes capacity checks across processes without overshooting the bound", async () => {
    openStore();
    // Seed near capacity efficiently; contending writes still use the public API.
    const seed = new Database(dbPath);
    try {
      const insert = seed.prepare("INSERT INTO bridge_deliveries (key_hash, claimed_at) VALUES (?, ?)");
      seed.transaction(() => {
        for (let index = 0; index < MAX_ENTRIES - 1; index++) {
          insert.run(createHash("sha256").update(`seed-${index}`).digest("hex"), NOW);
        }
      })();
    } finally {
      seed.close();
    }
    const results = await concurrentClaims([["new-1"], ["new-2"], ["new-3"], ["new-4"]], NOW);
    expect(results.flat().filter(Boolean)).toHaveLength(1);
    expect(inspectClaims()).toHaveLength(MAX_ENTRIES);
    expect(openStore().claimBridgeDelivery("seed-0", NOW)).toBe(false);
  }, 20_000);
});
