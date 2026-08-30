import { resolveWorkerReadProps } from "@/Cloudflare/Workers/WorkerProvider";
import * as Output from "@/Output";
import { describe, expect, test } from "alchemy-test";
import * as Option from "effect/Option";

// Cold adoption reads project desired props through
// `resolveReadProps` before the provider's `read` runs. The projection
// must never hand an unresolved leaf to the Cloudflare API, while keeping
// every identity-determining field concrete.

describe("resolveWorkerReadProps", () => {
  test("passes fully resolved props through", () => {
    const news = {
      name: "my-worker",
      env: { FOO: "bar" },
      crons: ["* * * * *"],
    };
    const projected = resolveWorkerReadProps(news as any);
    expect(Option.isSome(projected)).toBe(true);
    expect((projected as any).value).toEqual({
      name: "my-worker",
      env: { FOO: "bar" },
      crons: ["* * * * *"],
    });
  });

  test("omits an unresolved leaf inside env", () => {
    const projected = resolveWorkerReadProps({
      name: "my-worker",
      env: {
        RESOLVED: "yes",
        PENDING: Output.literal("later"),
      },
    } as any);
    expect(Option.isSome(projected)).toBe(true);
    const value = (projected as Option.Option<any>).value;
    // The unresolved binding is stripped so the read payload stays plain
    // data — an Output reaching the SDK protocol layer surfaces as
    // ParseError.
    expect(value.env.PENDING).toBeUndefined();
    expect(value.env.RESOLVED).toBe("yes");
  });

  test("returns None when the script name is unresolved", () => {
    const projected = resolveWorkerReadProps({
      name: Output.literal("my-worker"),
    } as any);
    expect(Option.isNone(projected)).toBe(true);
  });

  test("resolves a DispatchNamespace resource to its name", () => {
    const projected = resolveWorkerReadProps({
      name: "my-worker",
      namespace: { name: "outbound" },
    } as any);
    expect(Option.isSome(projected)).toBe(true);
    expect((projected as any).value.namespace).toBe("outbound");
  });

  test("returns None when the dispatch namespace is unresolved", () => {
    const projected = resolveWorkerReadProps({
      name: "my-worker",
      namespace: Output.literal("outbound"),
    } as any);
    expect(Option.isNone(projected)).toBe(true);
  });

  test("reduces version.parent to the parent script name", () => {
    const byResource = resolveWorkerReadProps({
      name: "versioned-worker",
      version: { parent: { workerName: "parent" } },
    } as any);
    expect(Option.isSome(byResource)).toBe(true);
    expect((byResource as any).value.version).toEqual({ parent: "parent" });

    const byName = resolveWorkerReadProps({
      name: "versioned-worker",
      version: { parent: "parent" },
    } as any);
    expect((byName as any).value.version).toEqual({ parent: "parent" });
  });

  test("returns None when the version parent is unresolved", () => {
    const projected = resolveWorkerReadProps({
      name: "versioned-worker",
      version: { parent: Output.literal("parent") },
    } as any);
    expect(Option.isNone(projected)).toBe(true);
  });

  test("keeps domain, routes, and crons only when fully resolved", () => {
    const projected = resolveWorkerReadProps({
      name: "my-worker",
      domain: Output.literal("example.com"),
      routes: [{ pattern: "example.com/*" }],
      crons: ["* * * * *"],
    } as any);
    expect(Option.isSome(projected)).toBe(true);
    const value = (projected as Option.Option<any>).value;
    expect(value.domain).toBeUndefined();
    expect(value.routes).toEqual([{ pattern: "example.com/*" }]);
    expect(value.crons).toEqual(["* * * * *"]);
  });
});
