import { AlchemyContext } from "@/AlchemyContext.ts";
import * as RpcProviderProxy from "@/Local/RpcProviderProxy.ts";
import { layerServer, RpcSpawner } from "@/Local/RpcSpawner.ts";
import { Stack } from "@/Stack.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const entry = new URL(
  "./fixtures/rpc-config-entry.ts",
  import.meta.url,
).toString();
const services = Layer.unwrap(
  RpcSpawner.useSync(({ url }) => RpcProviderProxy.layer(url)),
).pipe(
  Layer.provideMerge(layerServer({ profile: undefined, envFile: undefined })),
  Layer.provide(Layer.merge(PlatformServices, FetchHttpClient.layer)),
);
type Handlers = {
  captured: () => Effect.Effect<{
    token: string;
    build: number;
    closed: number;
    inherited: string | null;
  }>;
  tree: () => Effect.Effect<{ values: string[] }>;
  read: (key: string) => Effect.Effect<string>;
};
const get = (config: ConfigProvider.ConfigProvider, name = "first") =>
  RpcProviderProxy.RpcProviderProxy.use((proxy) =>
    proxy.get(entry, "Test.Config"),
  ).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, config),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: "/tmp/.alchemy",
      dev: true,
      adopt: false,
    }),
    Effect.provideService(Stack, {
      name,
      stage: "dev",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Effect.map((provider) => provider as unknown as Handlers),
  );
const config = (token: string | undefined) =>
  ConfigProvider.orElse(
    // Intentionally cannot enumerate its root: generic managers can be lazy.
    ConfigProvider.make((path) =>
      Effect.succeed(
        path.join(".") === "RPC_TEST_TOKEN" && token !== undefined
          ? ConfigProvider.makeValue(token)
          : undefined,
      ),
    ),
    ConfigProvider.fromUnknown({
      FALLBACK: "fallback",
      TREE: { values: ["first", "second"] },
    }),
  );

describe("Local.RpcProviderProxy configuration", () => {
  it.live(
    "uses managed and fallback values, preserves unchanged reloads, rebuilds changed credentials, and isolates stacks",
    () =>
      Effect.gen(function* () {
        const first = yield* get(config("first-token"));
        const original = yield* first.captured();
        expect(original.token).toBe("first-token");
        expect(original.inherited).toBeNull();
        expect(yield* first.read("FALLBACK")).toBe("fallback");
        expect(yield* first.read("MISSING")).toBe("absent");
        expect(yield* first.tree()).toEqual({ values: ["first", "second"] });
        const same = yield* get(config("first-token"));
        expect((yield* same.captured()).build).toBe(original.build);

        const failed = yield* get(
          ConfigProvider.make(() =>
            Effect.fail(
              new ConfigProvider.SourceError({
                message: "sensitive-diagnostic-token",
              }),
            ),
          ),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) {
          expect(Cause.pretty(failed.cause)).not.toContain(
            "sensitive-diagnostic-token",
          );
        }
        // Failed refreshes retain the existing context and permit recovery.
        const recovered = yield* get(config("first-token"));
        expect((yield* recovered.captured()).build).toBe(original.build);

        const other = yield* get(config("other-token"), "second");
        expect((yield* other.captured()).token).toBe("other-token");
        // A fresh proxy opens a new websocket, as a Bun dev reload does.
        const { url } = yield* RpcSpawner;
        const changed = yield* get(config("next-token")).pipe(
          Effect.provide(
            RpcProviderProxy.layer(url).pipe(
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
        );
        const updated = yield* changed.captured();
        expect(updated.token).toBe("next-token");
        expect(updated.build).not.toBe(original.build);
        expect(updated.closed).toBe(1);
        expect((yield* other.captured()).token).toBe("other-token");
        const removed = yield* get(config(undefined));
        expect((yield* removed.captured()).token).toBe("absent");
        const restored = yield* get(config("restored-token"));
        expect((yield* restored.captured()).token).toBe("restored-token");
      }).pipe(Effect.provide(services), Effect.scoped),
    { timeout: 60_000 },
  );
});
