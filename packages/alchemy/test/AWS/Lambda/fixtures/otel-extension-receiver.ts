import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { gunzipSync } from "node:zlib";

export class OtelExtensionReceiver extends Lambda.Function<Lambda.Function>()(
  "OtelExtensionReceiver",
) {}

export const OtelExtensionReceiverLive = OtelExtensionReceiver.make(
  {
    main: import.meta.url,
    memorySize: 256,
    timeout: Duration.seconds(15),
    url: true,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("OtelExtensionSink", {
      forceDestroy: true,
    });
    const bucketName = yield* bucket.bucketName;
    const putObject = yield* S3.PutObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (request.method === "GET") {
          return yield* HttpServerResponse.json({
            marker: "otel-extension-receiver-ok",
            bucketName: yield* bucketName,
          });
        }
        if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) {
          return HttpServerResponse.text("not found", { status: 404 });
        }

        const encoded = new Uint8Array(yield* request.arrayBuffer);
        const decoded =
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(encoded)
            : encoded;
        const raw = new TextDecoder().decode(decoded);
        yield* putObject({
          Key: `otlp/${crypto.randomUUID()}.json`,
          Body: JSON.stringify({
            signal: url.pathname.slice("/v1/".length),
            contentType: request.headers["content-type"],
            payload: raw,
          }),
          ContentType: "application/json",
        });

        const delayMs = Number(request.headers["x-otel-test-delay-ms"] ?? 0);
        if (Number.isFinite(delayMs) && delayMs > 0) {
          yield* Effect.sleep(Duration.millis(delayMs));
        }

        return yield* HttpServerResponse.json({ partialSuccess: {} });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(S3.PutObjectHttp))),
);

export default OtelExtensionReceiverLive;
