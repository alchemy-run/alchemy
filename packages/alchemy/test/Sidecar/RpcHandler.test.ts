import {
  defineSchema,
  deserializeRpcHandlers,
  type RpcHandlers,
  serializeRpcHandlers,
} from "@/Sidecar/RpcHandler.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

interface Handlers extends RpcHandlers {
  echo: (s: Redacted.Redacted<string>) => Effect.Effect<string>;
  password: (env: {
    password: Redacted.Redacted<string>;
  }) => Effect.Effect<string>;
  withDate: (env: { when: Date }) => Effect.Effect<string>;
}

const schema = defineSchema<Handlers>({
  echo: { success: Schema.String, error: Schema.Never },
  password: { success: Schema.String, error: Schema.Never },
  withDate: { success: Schema.String, error: Schema.Never },
});

const handlers: Handlers = {
  echo: (s) => Effect.succeed(Redacted.value(s)),
  password: (env) => Effect.succeed(Redacted.value(env.password)),
  withDate: ((env: { when: unknown }) =>
    Effect.succeed(String(env.when))) as Handlers["withDate"],
};

const client = () =>
  deserializeRpcHandlers(serializeRpcHandlers(handlers, schema), schema);

describe("Sidecar.RpcHandler", () => {
  it.effect("round-trips a top-level Redacted argument", () =>
    Effect.gen(function* () {
      expect(yield* client().echo(Redacted.make("hush"))).toBe("hush");
    }),
  );

  it.effect("round-trips a Redacted nested inside an object", () =>
    Effect.gen(function* () {
      expect(
        yield* client().password({ password: Redacted.make("hush") }),
      ).toBe("hush");
    }),
  );

  it.effect("preserves objects with their own toJSON (Date)", () =>
    Effect.gen(function* () {
      const d = new Date("2026-05-16T12:00:00.000Z");
      expect(yield* client().withDate({ when: d })).toBe(d.toISOString());
    }),
  );
});
