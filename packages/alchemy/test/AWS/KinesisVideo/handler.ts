import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class KinesisVideoTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KinesisVideoTestFunction",
) {}

export default KinesisVideoTestFunction.make(
  {
    main,
    url: true,
    // every route fans out to GetDataEndpoint/GetSignalingChannelEndpoint
    // plus the data-plane call; the 3s default is too tight
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const stream = yield* AWS.KinesisVideo.Stream("FixtureStream", {
      mediaType: "video/h264",
      dataRetentionInHours: "24 hours",
    });
    const channel = yield* AWS.KinesisVideo.SignalingChannel("FixtureChannel");

    const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
    const getIceServers = yield* AWS.KinesisVideo.GetIceServerConfig(channel);
    const getMedia = yield* AWS.KinesisVideo.GetMedia(stream);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/info") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/hls") {
          // The fixture stream has no ingested media, so LIVE playback
          // deterministically fails with a typed error from the archived
          // media data plane — reaching it at all proves endpoint discovery,
          // IAM, and the signed call.
          const result = yield* Effect.result(getHls({ PlaybackMode: "LIVE" }));
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              url: result.success.HLSStreamingSessionURL,
            });
          }
          return yield* HttpServerResponse.json({
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/ice") {
          const config = yield* getIceServers({ ClientId: "alchemy-test" });
          return yield* HttpServerResponse.json({
            servers: (config.IceServerList ?? []).map((server) => ({
              uris: server.Uris ?? [],
              hasCredentials:
                server.Username !== undefined && server.Password !== undefined,
              ttl: server.Ttl,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/media") {
          // The empty stream never produces fragments; the connection to the
          // per-stream media endpoint either opens (headers arrive) or idles
          // until the bounded timeout. Both prove the data-plane call was
          // accepted — auth/endpoint failures surface as typed errors.
          const result = yield* Effect.result(
            getMedia({
              StartSelector: { StartSelectorType: "EARLIEST" },
            }).pipe(Effect.timeoutOption("5 seconds")),
          );
          if (Result.isSuccess(result)) {
            if (Option.isNone(result.success)) {
              return yield* HttpServerResponse.json({
                ok: true,
                timedOut: true,
              });
            }
            return yield* HttpServerResponse.json({
              ok: true,
              contentType: result.success.value.ContentType,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.KinesisVideo.GetHLSStreamingSessionURLHttp,
        AWS.KinesisVideo.GetIceServerConfigHttp,
        AWS.KinesisVideo.GetMediaHttp,
      ),
    ),
  ),
);
