import {
  dashboardUrl,
  DEFAULT_HOST,
  normalizeHost,
  resolveHostFromEnv,
  toWebSocketUri,
} from "@/SpacetimeDB/Host.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const normalize = (input: string) => Effect.runSync(normalizeHost(input));

describe("normalizeHost", () => {
  test("maincloud nicknames resolve to the default Maincloud origin", () => {
    expect(normalize("maincloud")).toBe(DEFAULT_HOST);
    expect(normalize("maincloud.spacetimedb.com")).toBe(DEFAULT_HOST);
    expect(normalize("https://maincloud.spacetimedb.com")).toBe(DEFAULT_HOST);
    expect(normalize("https://maincloud.spacetimedb.com/")).toBe(DEFAULT_HOST);
  });

  test("local nicknames resolve to the standalone default", () => {
    expect(normalize("local")).toBe("http://127.0.0.1:3000");
    expect(normalize("localhost")).toBe("http://127.0.0.1:3000");
  });

  test("bare hostnames get an https scheme", () => {
    expect(normalize("db.example.com")).toBe("https://db.example.com");
  });

  test("full URLs keep scheme, host, and port; path is stripped", () => {
    expect(normalize("http://127.0.0.1:3000/v1")).toBe("http://127.0.0.1:3000");
    expect(normalize("https://db.example.com:8443/foo")).toBe(
      "https://db.example.com:8443",
    );
  });

  test("invalid input fails with AuthError", () => {
    const result = Effect.runSync(Effect.result(normalizeHost("")));
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("toWebSocketUri", () => {
  test("https becomes wss", () => {
    expect(toWebSocketUri("https://maincloud.spacetimedb.com")).toBe(
      "wss://maincloud.spacetimedb.com",
    );
  });

  test("http becomes ws", () => {
    expect(toWebSocketUri("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });
});

describe("dashboardUrl", () => {
  test("Maincloud databases link to spacetimedb.com/<name>", () => {
    expect(dashboardUrl("my-game", DEFAULT_HOST)).toBe(
      "https://spacetimedb.com/my-game",
    );
  });

  test("self-hosted / local hosts have no dashboard", () => {
    expect(dashboardUrl("my-game", "https://db.example.com")).toBeUndefined();
    expect(dashboardUrl("my-game", "http://127.0.0.1:3000")).toBeUndefined();
    expect(dashboardUrl("my-game", "http://localhost:3000")).toBeUndefined();
  });
});

describe("resolveHostFromEnv", () => {
  const resolveWith = (env: Record<string, string>) =>
    Effect.runSync(
      resolveHostFromEnv.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env }),
        ),
      ),
    );

  test("defaults to Maincloud when no env is set", () => {
    expect(resolveWith({})).toBe(DEFAULT_HOST);
  });

  test("SPACETIMEDB_HOST wins over SPACETIME_HOST", () => {
    expect(
      resolveWith({
        SPACETIMEDB_HOST: "https://a.example.com",
        SPACETIME_HOST: "https://b.example.com",
      }),
    ).toBe("https://a.example.com");
  });

  test("SPACETIME_HOST is consulted when SPACETIMEDB_HOST is absent", () => {
    expect(resolveWith({ SPACETIME_HOST: "local" })).toBe(
      "http://127.0.0.1:3000",
    );
  });
});
