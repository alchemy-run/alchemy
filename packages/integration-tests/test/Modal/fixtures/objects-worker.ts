import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * Creates a volume, a dict, a queue and a secret by name at run time, in the
 * workspace's default environment. Each name carries the host's owner prefix.
 */
export default class ObjectsWorker extends Cloudflare.Worker<ObjectsWorker>()(
  "ModalObjectsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const volumes = yield* Modal.CreateVolume();
    const dicts = yield* Modal.CreateDict();
    const queues = yield* Modal.CreateQueue();
    const secrets = yield* Modal.CreateSecret();
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://host").searchParams.get("key");
        // Only the test's own requests create objects: a request without a
        // key (a probe of the fresh URL) would leave objects behind.
        if (key === null) return HttpServerResponse.empty({ status: 404 });
        const name = `tags-${key}`;
        yield* volumes.getOrCreate(name);
        yield* dicts.getOrCreate(name);
        yield* queues.getOrCreate(name);
        yield* secrets.put(name, { A: "1" });
        return yield* HttpServerResponse.json({
          // Each client lists its own objects by their unprefixed names.
          listed: {
            volumes: (yield* volumes.list()).includes(name),
            dicts: (yield* dicts.list()).includes(name),
            queues: (yield* queues.list()).includes(name),
            secrets: (yield* secrets.list()).includes(name),
          },
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Modal.CreateVolumeHttp,
        Modal.CreateDictHttp,
        Modal.CreateQueueHttp,
        Modal.CreateSecretHttp,
      ),
    ),
  ),
) {}
