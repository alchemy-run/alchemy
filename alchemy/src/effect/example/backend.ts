import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bind } from "../bind.ts";
import { Bucket } from "../bucket.ts";
import { Worker } from "../worker.ts";

// 1. resource declarations
export class Storage extends Bucket("storage") {}
export class Backend extends Worker("backend") {}

// 2. business logic
export const backend = Backend.implement(
  Effect.fn(function* (request) {
    const object = yield* Storage.get(request.url);
    yield* Storage.put(request.url, "hello");
    return new Response(object);
  }),
);

// 3. deploy infrastructure with least privilege policy
await Effect.runPromise(
  backend.pipe(bind(Bucket.Get(Storage), Bucket.Put(Storage))),
);

// 4. provide layers to construct physical handler
export default backend.pipe(Layer.provide(Storage, storage));
