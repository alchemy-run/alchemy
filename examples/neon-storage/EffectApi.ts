import * as Neon from "alchemy/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { resources } from "./resources.ts";

export default Neon.Function(
  "EffectApi",
  Effect.gen(function* () {
    const { branch } = yield* resources;
    return {
      branch,
      main: import.meta.url,
      env: { APP_TOKEN: Config.Redacted("NEON_STORAGE_APP_TOKEN") },
    };
  }),
  Effect.gen(function* () {
    const { uploads, settings } = yield* resources;
    const files = yield* Neon.ReadWriteBucket(uploads);
    const defaults = yield* Neon.ReadObject(settings);
    const token = yield* Config.Redacted("APP_TOKEN");
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(token)}`)
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        if (request.url.startsWith("/settings"))
          return yield* HttpServerResponse.json(yield* defaults.get());
        if (request.url.startsWith("/upload-url"))
          return yield* HttpServerResponse.json({
            url: yield* files.presignPut("incoming/browser.txt", {
              contentType: "text/plain",
              expiresIn: 300,
            }),
            headers: { "content-type": "text/plain" },
          });
        if (request.method === "PUT") {
          yield* files.put("incoming/message.txt", yield* request.text, {
            ContentType: "text/plain",
          });
          return HttpServerResponse.text("Uploaded");
        }
        return yield* HttpServerResponse.json({
          url: yield* files.presignGet("incoming/message.txt", {
            expiresIn: 300,
          }),
        });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Storage request failed", { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Neon.ReadWriteBucketHttp, Neon.ReadObjectHttp),
    ),
  ),
);
