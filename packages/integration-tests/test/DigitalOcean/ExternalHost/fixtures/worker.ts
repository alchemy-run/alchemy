import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DigitalOcean from "@alchemy.run/digitalocean";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

export const Files = DigitalOcean.Spaces.Bucket("ExternalHostFiles", {
  region: "nyc3",
  forceDestroy: true,
});
export const Greeting = DigitalOcean.Security.Secret("ExternalHostSecret", {
  values: { GREETING: Redacted.make("hello from digitalocean") },
});
export const Fns = DigitalOcean.Functions.Namespace("ExternalHostFns", { region: "nyc1" });
export const Add = Effect.gen(function* () {
  const fns = yield* Fns;
  return yield* DigitalOcean.Functions.Action("ExternalHostAdd", {
    namespace: fns,
    runtime: "nodejs:18",
    code: `function main(args) { return { sum: args.a + args.b } }`,
  });
});

/**
 * A Cloudflare Worker using DigitalOcean bindings: a foreign host, so each
 * binding hands the Worker its own scoped credential (a Spaces key, a
 * Functions access key), the values themselves (a secret), or the token
 * the caller passed (Insights) as Worker secrets. One route per binding; each answers `{ ok, result | error }`.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "DoExternalHostWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const bucket = yield* Files;
    const putObject = yield* DigitalOcean.Spaces.PutObject(bucket);
    const getObject = yield* DigitalOcean.Spaces.GetObject(bucket);
    const secret = yield* Greeting;
    const readSecret = yield* DigitalOcean.Security.ReadSecret(secret);
    const fn = yield* Add;
    const add = yield* DigitalOcean.Functions.InvokeFunction(fn);
    const token = yield* Config.Redacted("DO_TEST_KEY");
    const queryMetrics = yield* DigitalOcean.Insights.QueryMetrics({ token });
    const searchLogs = yield* DigitalOcean.Insights.SearchLogs({ token });
    const createResponse = yield* DigitalOcean.Inference.CreateResponse({ key: token });
    const createMessage = yield* DigitalOcean.Inference.CreateMessage({ key: token });

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/spaces":
            return yield* respond(
              Effect.gen(function* () {
                yield* putObject({
                  Key: "external.txt",
                  Body: "from-worker",
                  ContentType: "text/plain",
                });
                const object = yield* getObject({ Key: "external.txt" });
                const text = object.Body
                  ? yield* Stream.mkString(Stream.decodeText(object.Body))
                  : "";
                return { text };
              }),
            );
          case "/secret":
            return yield* respond(
              Effect.map(readSecret.get("GREETING"), (value) => ({ text: Redacted.value(value) })),
            );
          case "/function":
            return yield* respond(add<{ sum: number }>({ a: 40, b: 2 }));
          case "/insights":
            return yield* respond(
              Effect.gen(function* () {
                const metrics = yield* queryMetrics({ region: "nyc3", query: "vector(1)" });
                const logs = yield* searchLogs({
                  region: "nyc3",
                  time_range: { from: { relative: "1h" }, to: { relative: "now" } },
                });
                return { metrics, logs };
              }),
            );
          case "/responses":
            return yield* respond(
              Effect.map(
                createResponse({
                  model: "mistral-3-14B",
                  input: "Reply with exactly the word pong.",
                  max_output_tokens: 16,
                }),
                (out) => ({ outputs: out.output.length }),
              ),
            );
          case "/messages":
            return yield* respond(
              Effect.map(
                createMessage({
                  model: "mistral-3-14B",
                  max_tokens: 16,
                  messages: [{ role: "user", content: "Reply with exactly the word pong." }],
                }),
                (out) => ({ blocks: out.content.length }),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DigitalOcean.Spaces.PutObjectHttp,
        DigitalOcean.Spaces.GetObjectHttp,
        DigitalOcean.Security.ReadSecretHttp,
        DigitalOcean.Functions.InvokeFunctionHttp,
        DigitalOcean.Insights.QueryMetricsHttp,
        DigitalOcean.Insights.SearchLogsHttp,
        DigitalOcean.Inference.CreateResponseHttp,
        DigitalOcean.Inference.CreateMessageHttp,
      ),
    ),
  ),
) {}
