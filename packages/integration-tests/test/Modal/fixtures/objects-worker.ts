import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * Creates objects at runtime in the workspace's default environment: volumes
 * deleted with the stack (the default), dicts retained.
 */
export default class ObjectsWorker extends Cloudflare.Worker<ObjectsWorker>()(
  "ModalObjectsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const volumes = yield* Modal.CreateVolume();
    const dicts = yield* Modal.CreateDict(undefined, { onDestroy: "retain" });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://host").searchParams.get("key") ?? "k";
        const volume = yield* volumes.getOrCreate(`objects-${key}`);
        const dict = yield* dicts.getOrCreate(`objects-${key}`);
        return yield* HttpServerResponse.json({
          // The stamped names the objects have in Modal.
          volume: volume.attributes.name,
          dict: dict.attributes.name,
          listed: (yield* volumes.list()).includes(`objects-${key}`),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateVolumeHttp, Modal.CreateDictHttp))),
) {}
