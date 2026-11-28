import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const makeRuntimeContext = (env: Record<string, string | Redacted.Redacted<string>>) => {
  const service: BaseRuntimeContext = {
    Type: "Render.KeyValueTest",
    id: "render-kv-test",
    env: { ...env },
    get: <T>(key: string) => Effect.succeed(env[key] as T | undefined),
    set: (key: string, value: unknown) =>
      Effect.sync(() => {
        env[key] = value as string | Redacted.Redacted<string>;
        return key;
      }),
  };
  return Layer.succeed(RuntimeContext, service);
};

describe("Render.KeyValue", { tags: ["provider:render", "live"], timeout: 240_000 }, () => {
  t.test.provider(
    "provisions KeyValue, verifies TLS commands, binds ReadWriteKeyValue to WebService, plans noop, updates, and destroys",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.KeyValue);
        const program = (policy: Render.MaxmemoryPolicy) =>
          Effect.gen(function* () {
            const kv = yield* Render.KeyValue("Kv", {
              plan: "starter",
              region: "oregon",
              maxmemoryPolicy: policy,
              ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "alchemy-live-test" }],
            });
            const web = yield* Render.WebService(
              "KvWeb",
              {
                plan: "free",
                region: "oregon",
                skipDeployAfterUpdate: true,
                runtimeSource: {
                  image: {
                    imagePath: "docker.io/nginxdemos/hello",
                    tag: "plain-text",
                  },
                },
              },
              Effect.gen(function* () {
                yield* Render.ReadWriteKeyValue(kv);
              }).pipe(Effect.provide(Render.ReadWriteKeyValueHttp)),
            );
            return { kv, web };
          });

        const created = yield* stack.deploy(program("allkeys_lru"));
        expect(created.kv.status).toBe("available");
        expect(Redacted.value(created.web.envVars.REDIS_URL)).toBe(
          Redacted.value(created.kv.connectionInfo.internalConnectionString),
        );

        const found = yield* prov.lookup!({ id: created.kv.id });
        expect(found?.id).toBe(created.kv.id);
        expect((yield* prov.list!()).some((k) => k.id === created.kv.id)).toBe(true);

        const externalUrl = Redacted.value(created.kv.connectionInfo.externalConnectionString);
        expect(externalUrl.startsWith("redis")).toBe(true);

        const kvClient = yield* Render.ReadWriteKeyValue({
          Type: "Render.KeyValue",
          LogicalId: "Kv",
          connectionInfo: created.kv.connectionInfo,
        } as unknown as Render.KeyValue).pipe(Effect.provide(Render.ReadWriteKeyValueHttp));

        const rtLayer = makeRuntimeContext({
          RENDER_KV_KV_EXTERNAL: externalUrl,
          REDIS_URL: externalUrl,
        });
        const prevRuntime = (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
        yield* Effect.sync(() => {
          (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = true;
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              expect(yield* kvClient.ping().pipe(Effect.provide(rtLayer))).toBe("PONG");
              yield* kvClient.set("alchemy:live:key", "render-ok").pipe(Effect.provide(rtLayer));
              expect(yield* kvClient.get("alchemy:live:key").pipe(Effect.provide(rtLayer))).toBe(
                "render-ok",
              );
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (prevRuntime === undefined) {
                delete (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
              } else {
                (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = prevRuntime;
              }
            }),
          ),
        );

        yield* expectAllNoop(stack, program("allkeys_lru"));

        const updated = yield* stack.deploy(program("volatile_lru"));
        expect(updated.kv.id).toBe(created.kv.id);
        expect(updated.kv.maxmemoryPolicy).toBe("volatile_lru");

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.kv.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 240_000 },
  );
});
