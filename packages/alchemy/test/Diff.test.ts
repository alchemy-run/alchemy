import {
  deepEqual,
  hasUnresolvedInputs,
  havePropsChanged,
  stripEffects,
  stripUnresolved,
} from "@/Diff";
import { describe, expect, test } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("Diff", () => {
  describe("havePropsChanged with Redacted values", () => {
    // Config values yielded in a Worker's init phase (e.g.
    // `yield* Config.string("MY_VARIABLE")`) land in `props.env`
    // as `Redacted<string>`. Before unwrapping, every Redacted serialized
    // to the constant mask `"<redacted>"`, so a changed secret was
    // invisible to the diff and the Worker never redeployed.
    test("detects a changed yielded config value in env", () => {
      const olds = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-CHANGED"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(true);
    });

    test("does not flag an unchanged yielded config value", () => {
      const olds = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(false);
    });

    test("detects a changed top-level Redacted value", () => {
      expect(
        havePropsChanged(
          { secret: Redacted.make("a") },
          { secret: Redacted.make("b") },
        ),
      ).toBe(true);
    });

    test("detects a Redacted value changing to a different inner type", () => {
      expect(
        havePropsChanged(
          { secret: Redacted.make("123") },
          { secret: Redacted.make(123) },
        ),
      ).toBe(true);
    });

    test("detects a changed Redacted value nested in arrays", () => {
      expect(
        havePropsChanged(
          { secrets: [Redacted.make("a"), Redacted.make("b")] },
          { secrets: [Redacted.make("a"), Redacted.make("c")] },
        ),
      ).toBe(true);
    });

    test("does not flag unchanged plain env values", () => {
      expect(
        havePropsChanged(
          { env: { MY_VARIABLE: "value" } },
          { env: { MY_VARIABLE: "value" } },
        ),
      ).toBe(false);
    });

    test("detects changed env when a Redacted value sits alongside plain values", () => {
      const olds = {
        env: {
          MY_VARIABLE: "value",
          MY_SECRET: Redacted.make("secret-1"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: "value",
          MY_SECRET: Redacted.make("secret-2"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(true);
    });
  });

  describe("deepEqual with Redacted values", () => {
    test("distinguishes Redacted values with different inner values", () => {
      expect(deepEqual(Redacted.make("a"), Redacted.make("b"))).toBe(false);
    });

    test("equates Redacted values with the same inner value", () => {
      expect(deepEqual(Redacted.make("a"), Redacted.make("a"))).toBe(true);
    });

    test("distinguishes Redacted values nested in objects", () => {
      expect(
        deepEqual(
          { secret: Redacted.make("a") },
          { secret: Redacted.make("b") },
        ),
      ).toBe(false);
    });
  });

  // effect ≥4.0.0-beta.103's Context is self-referential; every deep walker
  // must treat Effect/Layer/Context values as leaves instead of recursing
  // into (or JSON-encoding) their internals (#1082).
  describe("opaque effect values in props (#1082)", () => {
    const opaqueProps = () => ({
      name: "worker",
      exports: {
        Store: {
          kind: "durableObject",
          constructor: Effect.void,
          services: Context.empty(),
        },
      },
      layer: Layer.empty,
    });

    test("hasUnresolvedInputs treats Layer/Context as resolved leaves", () => {
      expect(
        hasUnresolvedInputs({ context: Context.empty(), layer: Layer.empty }),
      ).toBe(false);
    });

    test("stripUnresolved drops Effect/Layer/Context", () => {
      const stripped: any = stripUnresolved(opaqueProps());
      expect(stripped.name).toBe("worker");
      expect(stripped.exports.Store.kind).toBe("durableObject");
      expect(stripped.exports.Store.constructor).toBeUndefined();
      expect(stripped.exports.Store.services).toBeUndefined();
      expect(stripped.layer).toBeUndefined();
      // Round-trips through JSON — the commit boundary's contract.
      expect(() => JSON.stringify(stripped)).not.toThrow();
    });

    test("stripEffects drops Effect/Layer/Context", () => {
      const stripped: any = stripEffects(opaqueProps());
      expect(stripped.exports.Store.constructor).toBeUndefined();
      expect(stripped.exports.Store.services).toBeUndefined();
      expect(stripped.layer).toBeUndefined();
    });

    test("havePropsChanged terminates and compares only plain data", () => {
      expect(havePropsChanged(opaqueProps(), opaqueProps())).toBe(false);
      expect(
        havePropsChanged(opaqueProps(), {
          ...opaqueProps(),
          name: "renamed",
        }),
      ).toBe(true);
    });

    test("deepEqual does not recurse into Context internals", () => {
      expect(
        deepEqual({ ctx: Context.empty() }, { ctx: Context.empty() }),
      ).toBe(true);
    });

    test("havePropsChanged terminates on cyclic plain objects", () => {
      const make = () => {
        const cyclic: any = { name: "cycle" };
        cyclic.self = cyclic;
        return { config: cyclic };
      };
      // Cyclic plain objects can't be JSON-encoded; the walkers must not
      // hang before that surfaces. hasUnresolvedInputs is the cycle-prone
      // pre-pass — pin that it terminates.
      expect(hasUnresolvedInputs(make())).toBe(false);
    });
  });
});
