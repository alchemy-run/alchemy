import { describe, expect, it } from "@alchemy.run/test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RemovalPolicy from "@/RemovalPolicy";

class Boom extends Data.TaggedError("Boom")<{ readonly policy: string }> {}

// Reads the policy as Resource.ts does, then fails with a typed error.
const failWithPolicy = Effect.gen(function* () {
  const policy = yield* Effect.serviceOption(RemovalPolicy.RemovalPolicy);
  return yield* new Boom({ policy: Option.getOrElse(policy, () => "unset") });
});

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("RemovalPolicy", { tags: ["unit", "local"] }, () => {
  it.effect("retain() and destroy() keep the wrapped effect's error", () =>
    Effect.gen(function* () {
      const retained = yield* failWithPolicy.pipe(RemovalPolicy.retain(), Effect.flip);
      expect(retained).toEqual(new Boom({ policy: "retain" }));

      const destroyed = yield* failWithPolicy.pipe(RemovalPolicy.destroy(), Effect.flip);
      expect(destroyed).toEqual(new Boom({ policy: "destroy" }));
    }),
  );

  it.effect("enabled may be a fallible Effect such as a Config", () =>
    Effect.gen(function* () {
      const policy = yield* failWithPolicy.pipe(
        RemovalPolicy.retain(Config.Boolean("RETAIN")),
        Effect.flip,
        withEnv({ RETAIN: "false" }),
      );
      expect(policy).toEqual(new Boom({ policy: "destroy" }));

      const error = yield* failWithPolicy.pipe(
        RemovalPolicy.destroy(Config.Boolean("DESTROY")),
        Effect.flip,
        withEnv({}),
      );
      expect(error).toBeInstanceOf(Config.ConfigError);
    }),
  );
});
