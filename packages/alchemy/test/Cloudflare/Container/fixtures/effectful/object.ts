import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { MyContainer } from "./container.ts";
import { Storage } from "./storage.ts";

export class Object extends Cloudflare.DurableObjectNamespace<Object>()(
  "Object",
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWrite(Storage);
    const container = yield* MyContainer;

    const state = yield* Cloudflare.DurableObjectState;
    const conn = yield* container.getTcpPort(3000);

    yield* state.getWebSockets();

    yield* state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)",
    );

    return {
      get: (key: string) => bucket.get(key),
      ping: () => container.ping(),
      hello: () =>
        Effect.gen(function* () {
          const response = yield* conn.fetch(
            HttpClientRequest.get("http://container/"),
          );
          return yield* response.text;
        }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBinding,
        Cloudflare.layerContainer(MyContainer, {
          enableInternet: true,
        }),
      ),
    ),
  ),
) {}

export class Object2 extends Cloudflare.DurableObjectNamespace<
  Object,
  {
    ping: () => Effect.Effect<void>;
  }
>()("Object2") {}

export const Object2Live = Object2.make(
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWrite(Storage);
    const container = yield* MyContainer;
    return {
      ping: () => Effect.void,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBinding,
        Cloudflare.layerContainer(MyContainer, {
          enableInternet: true,
        }),
      ),
    ),
  ),
);
