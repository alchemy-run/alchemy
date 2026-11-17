import * as AWS from "@alchemy.run/aws";
import * as Fly from "@alchemy.run/fly";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const FlyBucket = AWS.S3.Bucket("FlyHostBucket", { forceDestroy: true });

/**
 * A Fly Service using AWS bindings: its Machines assume the Role Alchemy
 * creates for it with Fly OIDC tokens, so no AWS key is bound. Each route
 * answers `{ ok, result | error }` so a failure surfaces the AWS error.
 */
export default class FlyHostService extends Fly.Service<FlyHostService>()(
  "FlyHostService",
  {
    main: import.meta.url,
    region: "iad",
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const bucket = yield* FlyBucket;
    const putObject = yield* AWS.S3.PutObject(bucket);
    const getObject = yield* AWS.S3.GetObject(bucket);

    const respond = (effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        const key = url.searchParams.get("key") ?? "fly-host";
        switch (url.pathname) {
          case "/s3":
            return yield* respond(
              Effect.gen(function* () {
                yield* putObject({ Key: key, Body: "from-fly" });
                const object = yield* getObject({ Key: key });
                return { contentLength: object.ContentLength };
              }),
            );
          case "/identity":
            // What the Machine holds: a Role to assume, and no created key.
            return yield* respond(
              Effect.gen(function* () {
                const read = (name: string) =>
                  Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined));
                return {
                  roleArn: yield* read("ALCHEMY_AWS_WEB_IDENTITY_ROLE_ARN"),
                  hasAccessKey: (yield* read("ALCHEMY_AWS_ACCESS_KEY_ID")) !== undefined,
                };
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AWS.S3.PutObjectHttp, AWS.S3.GetObjectHttp))),
) {}
