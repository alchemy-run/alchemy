import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{ status: number }> {}

const getJsonReady = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const res = yield* client.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : Effect.fail(new WorkerNotReady({ status: res.status })),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkerNotReady",
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
        Schedule.recurs(10),
      ]),
    }),
  );
  return yield* res.json;
});

// The target is a real namespace in another stack. `Alchemy.remote()` keeps
// it live even though this file deploys in dev mode.
const TargetStack = Alchemy.Stack(
  "KVNamespaceLookupLocalTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.KV.Namespace("lookup-target").pipe(Alchemy.remote());
    return {
      title: namespace.title.as<string>(),
      namespaceId: namespace.namespaceId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

/**
 * Under `alchemy dev` a looked-up namespace keeps its real id, so the local
 * Worker's binding proxies to the live namespace. Out-of-band reads prove
 * the Worker's write landed there.
 */
test.provider(
  "a looked-up namespace binds remotely to a local Worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { title, namespaceId } = yield* target;
      expect(namespaceId).not.toMatch(/^dev:/);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("kv-lookup-local-worker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/kv-local-worker.ts"),
            env: { KV_LIVE: Cloudflare.KV.Namespace.lookup({ title }) },
          });
          return { url: worker.url.as<string>() };
        }),
      );
      expect(deployed.url).toMatch(/^http:\/\/localhost:/);

      const live = (yield* getJsonReady(`${deployed.url}/roundtrip?binding=KV_LIVE`)) as {
        value2: string;
      };
      expect(live.value2).toBe("value2");

      const { accountId } = yield* yield* CloudflareEnvironment;
      // The namespace was created moments ago. The Worker's write landed,
      // yet the KV values API can still answer `namespace not found` for it.
      const value = yield* kv.getNamespaceValue({ accountId, namespaceId, keyName: "key2" }).pipe(
        Effect.retry({
          while: (e) => e._tag === "NamespaceNotFound",
          schedule: Schedule.spaced("3 seconds"),
          times: 15,
        }),
        Effect.flatMap((res) =>
          Effect.tryPromise(() =>
            new Response(Stream.toReadableStream(res.body) as BodyInit).text(),
          ),
        ),
      );
      expect(value).toBe("value2");

      yield* stack.destroy();
      const survivor = yield* kv.getNamespace({ accountId, namespaceId });
      expect(survivor.title).toBe(title);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:kv", "local", "live"],
    timeout: 180_000,
  },
);
