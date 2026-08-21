import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Data, Site } from "./shared.ts";

/**
 * HTTP Service that attaches a Tigris bucket and serves the bucket
 * name (never the access key).
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Fly.AttachBucket(Data);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const bucket = yield* Config.redacted("BUCKET_NAME").pipe(
          Effect.orElseSucceed(() => Redacted.make("")),
        );
        const name = Redacted.value(bucket);
        if (path === "/health") {
          return yield* HttpServerResponse.json({
            ok: name.length > 0,
          });
        }
        return yield* HttpServerResponse.json({
          ok: name.length > 0,
          bucket: name,
        });
      }),
    };
  }).pipe(Effect.provide(Fly.AttachBucketLive)),
) {}
