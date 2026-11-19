import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Platform, type Main, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import type { BaseRuntimeContext } from "@/RuntimeContext.ts";
import { inMemoryState } from "@/State/index.ts";

interface ConfigHostProps extends PlatformProps {
  env?: Record<string, unknown>;
}

interface ConfigHost extends Resource<
  "Test.ConfigHost",
  ConfigHostProps,
  { ready: true },
  { env?: Record<string, unknown> }
> {}

const boundKeys: string[] = [];

const ConfigHost: Platform<ConfigHost, never, Main, BaseRuntimeContext> = Platform(
  "Test.ConfigHost",
  {
    createRuntimeContext: (id): BaseRuntimeContext => ({
      Type: "Test.ConfigHost",
      id,
      env: {},
      set: (key) =>
        Effect.sync(() => {
          boundKeys.push(key);
          return key;
        }),
      get: <T>() => Effect.succeed<T | undefined>(undefined),
    }),
  },
);

const providers = Provider.succeed(ConfigHost, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* () {
    return { ready: true as const };
  }),
  delete: Effect.fn(function* () {}),
});

const { test } = Test.make({ providers, state: inMemoryState() });

test.provider(
  "an absent optional field skips synthetic binding and preserves concrete config bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      boundKeys.length = 0;

      yield* stack.deploy(
        ConfigHost(
          "ConfigHost",
          {},
          Effect.gen(function* () {
            const optional = yield* Config.schema(
              Schema.Struct({ maybe: Schema.optional(Schema.String) }),
            );
            expect(optional).toEqual({});

            const concrete = yield* Config.String("ALCHEMY_TEST_PRESENT_CONFIG");
            expect(concrete).toBe("present");
            return {};
          }),
        ),
      );

      expect(boundKeys).toEqual(["ALCHEMY_TEST_PRESENT_CONFIG"]);
      yield* stack.destroy();
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ALCHEMY_TEST_PRESENT_CONFIG: "present",
          }),
        ),
      ),
    ),
  { tags: ["unit", "local"] },
);
