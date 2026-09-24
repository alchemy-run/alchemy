import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // #region construct
    const bucket = yield* AWS.S3.Bucket("Uploads");
    const getObject = yield* AWS.S3.GetObject(bucket);
    const putObject = yield* AWS.S3.PutObject(bucket);
    // #endregion construct

    return {
      fetch: Effect.gen(function* () {
        const object = yield* getObject({ Key: "hello.txt" });
        return HttpServerResponse.text(`${object.ContentLength} bytes`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide([AWS.S3.GetObjectHttp, AWS.S3.PutObjectHttp])),
) {}
// #endregion show
