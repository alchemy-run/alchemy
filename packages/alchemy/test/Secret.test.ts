import * as Output from "@/Output";
import { RuntimeContext } from "@/RuntimeContext";
import { Secret } from "@/Secret";
import { inMemoryState } from "@/State/InMemoryState";
import { Variable } from "@/Variable";
import { describe, expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const TestRuntime = RuntimeContext("AlchemyTest::Secret");

interface Stored {
  env: Record<string, Output.Output>;
}

const makeTestRuntime = () => {
  const stored: Stored = { env: {} };
  const ctx = {
    Type: "AlchemyTest::Secret",
    id: "test",
    env: stored.env,
    get: <T>(key: string): Effect.Effect<T> => {
      const expr = stored.env[key];
      if (!expr)
        return Effect.die(`missing binding ${key}`) as Effect.Effect<T>;
      return Output.evaluate(expr, {}) as Effect.Effect<T>;
    },
    set: (id: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
        stored.env[key] = output;
        return key;
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(TestRuntime, ctx),
    Layer.succeed(RuntimeContext, ctx),
  );
  return { stored, layer };
};

const withConfig = (record: Record<string, string>) =>
  Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(record),
  );

const baseLayers = (
  layer: Layer.Layer<any, any, any>,
  config?: Record<string, string>,
) =>
  Layer.mergeAll(
    layer,
    inMemoryState(),
    config ? withConfig(config) : Layer.empty,
  );

describe("Alchemy.Secret", () => {
  it.effect("one-arg shortcut reads Config.redacted(name)", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Secret("API_KEY");
      const value = yield* accessor;
      expect(Redacted.isRedacted(value)).toBe(true);
      expect(Redacted.value(value)).toBe("from-env");
      expect(Object.keys(stored.env)).toEqual(["API_KEY"]);
    }).pipe(Effect.provide(baseLayers(layer, { API_KEY: "from-env" })));
  });

  it.effect("wraps a literal string in Redacted", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Secret("TOKEN", "literal-value");
      const value = yield* accessor;
      expect(Redacted.isRedacted(value)).toBe(true);
      expect(Redacted.value(value)).toBe("literal-value");
      expect(stored.env.TOKEN).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer)));
  });

  it.effect("passes through an existing Redacted unchanged", () => {
    const { stored, layer } = makeTestRuntime();
    const original = Redacted.make("already-redacted");
    return Effect.gen(function* () {
      const accessor = yield* Secret("TOKEN", original);
      const value = yield* accessor;
      expect(Redacted.isRedacted(value)).toBe(true);
      expect(Redacted.value(value)).toBe("already-redacted");
      const stored1 = yield* Output.evaluate(stored.env.TOKEN!, {});
      expect(Redacted.value(stored1 as Redacted.Redacted<string>)).toBe(
        "already-redacted",
      );
    }).pipe(Effect.provide(baseLayers(layer)));
  });

  it.effect("resolves a value from an Effect", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Secret("TOKEN", Effect.succeed("from-effect"));
      const value = yield* accessor;
      expect(Redacted.value(value)).toBe("from-effect");
      expect(stored.env.TOKEN).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer)));
  });

  it.effect("resolves a value from a Config", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Secret("TOKEN", Config.string("MY_KEY"));
      const value = yield* accessor;
      expect(Redacted.value(value)).toBe("config-value");
      expect(stored.env.TOKEN).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer, { MY_KEY: "config-value" })));
  });
});

describe("Worker env contract", () => {
  // Mirrors the env -> metadata bindings loop in
  // packages/alchemy/src/Cloudflare/Workers/Worker.ts (~L1653) so we can
  // verify that yielded secret/variable values produce the correct
  // Cloudflare binding `type` without standing up a real Worker.
  type MetaBinding =
    | { type: "secret_text"; name: string; text: string }
    | { type: "plain_text"; name: string; text: string }
    | { type: "json"; name: string; json: unknown };

  const buildBindings = (env: Record<string, unknown>): MetaBinding[] => {
    const out: MetaBinding[] = [];
    for (const [name, value] of Object.entries(env)) {
      if (Redacted.isRedacted(value)) {
        out.push({
          type: "secret_text",
          name,
          text: Redacted.value(value) as string,
        });
      } else if (typeof value === "string") {
        out.push({ type: "plain_text", name, text: value });
      } else {
        out.push({ type: "json", name, json: value });
      }
    }
    return out;
  };

  it.effect("Alchemy.Secret env entry serializes as secret_text", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      yield* Secret("API_KEY", "sk-123");
      yield* Secret("FROM_CONFIG", Config.string("MY_KEY"));

      const env: Record<string, unknown> = {};
      for (const [k, expr] of Object.entries(stored.env)) {
        env[k] = yield* Output.evaluate(expr, {});
      }
      const bindings = buildBindings(env);
      expect(bindings).toEqual(
        expect.arrayContaining([
          { type: "secret_text", name: "API_KEY", text: "sk-123" },
          { type: "secret_text", name: "FROM_CONFIG", text: "from-config" },
        ]),
      );
    }).pipe(Effect.provide(baseLayers(layer, { MY_KEY: "from-config" })));
  });

  it.effect(
    "Alchemy.Variable env entry serializes as plain_text or json",
    () => {
      const { stored, layer } = makeTestRuntime();
      return Effect.gen(function* () {
        yield* Variable("HOST", "localhost");
        yield* Variable("PORT", 3000);
        yield* Variable("FLAGS", { beta: true });

        const env: Record<string, unknown> = {};
        for (const [k, expr] of Object.entries(stored.env)) {
          env[k] = yield* Output.evaluate(expr, {});
        }
        const bindings = buildBindings(env);
        expect(bindings).toEqual(
          expect.arrayContaining([
            { type: "plain_text", name: "HOST", text: "localhost" },
            { type: "json", name: "PORT", json: 3000 },
            { type: "json", name: "FLAGS", json: { beta: true } },
          ]),
        );
      }).pipe(Effect.provide(baseLayers(layer)));
    },
  );
});

describe("Alchemy.Variable", () => {
  it.effect("one-arg shortcut reads Config.string(name)", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Variable("HOST");
      const value = yield* accessor;
      expect(value).toBe("localhost");
      expect(Redacted.isRedacted(value)).toBe(false);
      expect(Object.keys(stored.env)).toEqual(["HOST"]);
    }).pipe(Effect.provide(baseLayers(layer, { HOST: "localhost" })));
  });

  it.effect("binds a literal value", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Variable("PORT", 3000);
      expect(yield* accessor).toBe(3000);
      expect(stored.env.PORT).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer)));
  });

  it.effect("binds a value resolved from an Effect", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Variable("HOST", Effect.succeed("from-effect"));
      expect(yield* accessor).toBe("from-effect");
      expect(stored.env.HOST).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer)));
  });

  it.effect("binds a value resolved from a Config", () => {
    const { stored, layer } = makeTestRuntime();
    return Effect.gen(function* () {
      const accessor = yield* Variable("HOST", Config.string("MY_HOST"));
      expect(yield* accessor).toBe("config-host");
      expect(stored.env.HOST).toBeDefined();
    }).pipe(Effect.provide(baseLayers(layer, { MY_HOST: "config-host" })));
  });
});
