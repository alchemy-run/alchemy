// Executed directly by the child, like rpc-server-entry.ts. Excluded from the
// test composite project because the source import crosses project boundaries.
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { launch } from "../../../src/Local/RpcServer.ts";

let builds = 0;
let closed = 0;
const TestConfig = Context.Service<any, any>("Test.Config");
launch(
  Layer.effect(
    TestConfig,
    Effect.gen(function* () {
      const config = yield* ConfigProvider.ConfigProvider;
      const token = yield* Config.string("RPC_TEST_TOKEN").pipe(
        Config.withDefault("absent"),
      );
      const build = ++builds;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      return {
        captured: () =>
          Effect.sync(() => ({
            token,
            build,
            closed,
            inherited: process.env.RPC_TEST_TOKEN ?? null,
          })),
        tree: () =>
          Config.schema(
            Schema.Struct({ values: Schema.Array(Schema.String) }),
            "TREE",
          ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)),
        readUpper: (key: string) =>
          Config.string(key).pipe(
            Config.withDefault("absent"),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.constantCase(config),
            ),
          ),
        read: (key: string) =>
          Config.string(key).pipe(
            Config.withDefault("absent"),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
          ),
      };
    }),
  ),
);
