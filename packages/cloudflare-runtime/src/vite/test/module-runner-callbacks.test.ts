import { makeCallbackRegistry } from "../module-runner/callbacks.shared.ts";
import { describe, expect, test } from "vitest";

describe("module runner callback registry", () => {
  test("hands the result back and forgets the entry", async () => {
    const registry = makeCallbackRegistry();
    const namespace = { default: "module" };
    const result = await registry.run(
      (id) => registry.execute(id),
      async () => namespace,
    );
    expect(result).toBe(namespace);
    expect(registry.size).toBe(0);
  });

  test("forgets the entry when the callback fails", async () => {
    const registry = makeCallbackRegistry();
    await expect(
      registry.run(
        (id) => registry.execute(id),
        async () => {
          throw new Error("evaluation failed");
        },
      ),
    ).rejects.toThrow("evaluation failed");
    expect(registry.size).toBe(0);
  });

  test("forgets the entry when the callback never runs", async () => {
    const registry = makeCallbackRegistry();
    await expect(
      registry.run(
        async () => {
          throw new Error("rpc failed");
        },
        async () => "unreached",
      ),
    ).rejects.toThrow("rpc failed");
    expect(registry.size).toBe(0);
  });

  test("keeps concurrent callbacks apart", async () => {
    const registry = makeCallbackRegistry();
    const results = await Promise.all(
      [1, 2, 3].map((value) =>
        registry.run(
          (id) => registry.execute(id),
          async () => value * 10,
        ),
      ),
    );
    expect(results).toEqual([10, 20, 30]);
    expect(registry.size).toBe(0);
  });

  test("rejects an unknown id", async () => {
    const registry = makeCallbackRegistry();
    await expect(registry.execute(42)).rejects.toThrow(
      "No pending callback with id 42",
    );
  });
});
