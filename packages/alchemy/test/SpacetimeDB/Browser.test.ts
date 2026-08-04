import { describe, expect, test } from "alchemy-test";
import { storageKeyFor, withTokenPersistence } from "@/SpacetimeDB/Browser.ts";

class FakeBuilder {
  uri = "";
  name = "";
  token: string | undefined = undefined;
  onConnectCb:
    | ((conn: unknown, identity: unknown, token: string) => void)
    | undefined;
  onErrorCb: ((ctx: unknown, error: Error) => void) | undefined;
  withUri(uri: string) {
    this.uri = uri;
    return this;
  }
  withDatabaseName(name: string) {
    this.name = name;
    return this;
  }
  withToken(token?: string) {
    this.token = token;
    return this;
  }
  onConnect(cb: (conn: unknown, identity: unknown, token: string) => void) {
    this.onConnectCb = cb;
    return this;
  }
  onConnectError(cb: (ctx: unknown, error: Error) => void) {
    this.onErrorCb = cb;
    return this;
  }
  onDisconnect() {
    return this;
  }
  build() {
    return { ...this };
  }
}

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
};

describe("storageKeyFor", () => {
  test("produces a per-(uri, databaseName) key", () => {
    expect(storageKeyFor("wss://a", "db1")).toBe(
      "spacetimedb.token.wss://a.db1",
    );
    expect(storageKeyFor("wss://a", "db2")).toBe(
      "spacetimedb.token.wss://a.db2",
    );
    expect(storageKeyFor("wss://b", "db1")).not.toBe(
      storageKeyFor("wss://a", "db1"),
    );
  });
});

describe("withTokenPersistence", () => {
  test("applies saved token via withToken on build", () => {
    const storage = memoryStorage();
    storage.setItem("spacetimedb.token.wss://a.db1", "saved-token");
    const raw = new FakeBuilder();
    withTokenPersistence(raw, { storage })
      .withUri("wss://a")
      .withDatabaseName("db1")
      .build();
    expect(raw.token).toBe("saved-token");
  });

  test("persists new token to storage on connect", () => {
    const storage = memoryStorage();
    const raw = new FakeBuilder();
    withTokenPersistence(raw, { storage })
      .withUri("wss://a")
      .withDatabaseName("db1")
      .build();
    raw.onConnectCb?.({}, { hex: "id" }, "fresh-token");
    expect(storage.getItem("spacetimedb.token.wss://a.db1")).toBe(
      "fresh-token",
    );
  });

  test("clears storage on connect error", () => {
    const storage = memoryStorage();
    storage.setItem("spacetimedb.token.wss://a.db1", "stale");
    const raw = new FakeBuilder();
    withTokenPersistence(raw, { storage })
      .withUri("wss://a")
      .withDatabaseName("db1")
      .build();
    raw.onErrorCb?.(null, new Error("revoked"));
    expect(storage.getItem("spacetimedb.token.wss://a.db1")).toBeNull();
  });
});
