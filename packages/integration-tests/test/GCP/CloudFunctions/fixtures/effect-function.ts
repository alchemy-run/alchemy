import * as GCP from "@alchemy.run/gcp";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { jsonStrings, type JsonStringKey } from "../../../JsonStrings.ts";

// `Config.String` for every entry in `jsonStrings`.
const readJsonStrings = <A>(map: (config: Config.Config<string>) => Config.Config<A>) =>
  Object.fromEntries(
    Object.keys(jsonStrings).map((key) => [key, map(Config.String(key))]),
  ) as Record<JsonStringKey, Config.Config<A>>;

/** Bucket the function writes to from `fetch` and from topic deliveries. */
export const Marker = GCP.Storage.Bucket("FnMarker", { forceDestroy: true });
/** Topic pushed to the function through a push subscription. */
export const Pings = GCP.PubSub.Topic("FnPings", {});

/**
 * Effect-native Cloud Function: an HTTP `fetch` using Storage bindings,
 * plus a Pub/Sub push event source that records each message.
 * Deployed from {@link ../EffectNative.test.ts}.
 */
export default class EffectFunction extends GCP.CloudFunctions.Function<EffectFunction>()(
  "EffectFunction",
  // `env` strings `JSON.parse` would reinterpret must deploy and read back
  // unchanged (`/json-strings`).
  { main: import.meta.url, location: "us-central1", env: { ...jsonStrings } },
  Effect.gen(function* () {
    // Optional so plan passes: these are bound from `env`, not from the
    // deploy-time ConfigProvider.
    const initJsonStrings = yield* Config.all({
      ...readJsonStrings((config) => config.pipe(Config.option)),
      JSON_FALSE_BOOL: Config.Boolean("JSON_FALSE").pipe(Config.option),
      JSON_NUM_NUMBER: Config.Number("JSON_NUM").pipe(Config.option),
    });
    const bucket = yield* Marker;
    const putObject = yield* GCP.Storage.PutObject(bucket);
    const getObject = yield* GCP.Storage.GetObject(bucket);

    yield* GCP.PubSub.consumeTopicMessages(yield* Pings, (messages) =>
      messages.pipe(
        Stream.runForEach(({ message }) =>
          putObject({
            name: `ping-${message.messageId}.txt`,
            body: atob(message.data ?? ""),
          }).pipe(Effect.orDie),
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.originalUrl, "http://x").pathname === "/json-strings") {
          const runtime = yield* Config.all({
            ...readJsonStrings((config) => config),
            JSON_FALSE_BOOL: Config.Boolean("JSON_FALSE"),
            JSON_NUM_NUMBER: Config.Number("JSON_NUM"),
          }).pipe(Effect.orDie);
          const env = yield* Effect.sync(() =>
            // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
            Object.fromEntries(Object.keys(jsonStrings).map((key) => [key, process.env[key]])),
          );
          return yield* HttpServerResponse.json({
            init: Object.fromEntries(
              Object.entries(initJsonStrings).map(([k, v]: [string, Option.Option<unknown>]) => [
                k,
                Option.getOrNull(v),
              ]),
            ),
            runtime,
            env,
          });
        }
        yield* putObject({ name: "hello.txt", body: "from-function" }).pipe(Effect.orDie);
        const { body } = yield* getObject({ object: "hello.txt" }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          read: new TextDecoder().decode(body),
          node: yield* Effect.sync(() => process.versions.node),
        });
      }),
    };
  }).pipe(
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
    Effect.provide(GCP.CloudFunctions.TopicEventSource),
  ),
) {}
