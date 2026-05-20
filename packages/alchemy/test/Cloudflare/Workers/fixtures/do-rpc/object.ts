import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

const KV = Cloudflare.KVNamespace("DurableObjectWorkerEnvironmentKV", {
  title: "durable-object-worker-environment-kv",
});

export class WorkerEnvironmentKVObject extends Cloudflare.DurableObjectNamespace<WorkerEnvironmentKVObject>()(
  "WorkerEnvironmentKVObject",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);

    return Effect.gen(function* () {
      return {
        put: (key: string, value: string) => kv.put(key, value),
        get: (key: string) => kv.get(key),
      };
    });
  }).pipe(Effect.provide(Cloudflare.KVNamespaceBindingLive)),
) {}
