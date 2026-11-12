import * as AWS from "@alchemy.run/aws";
import * as Modal from "@alchemy.run/modal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import Api from "./api-server.ts";
import { AsyncEmbed } from "./async-function.ts";
import Embed from "./embed-function.ts";
import Relay from "./relay-function.ts";
import { Services } from "./services.ts";
import Web from "./web-function.ts";

const BindingsLive = Layer.mergeAll(
  Modal.InvokeFunctionHttp,
  Modal.ReadFunctionHttp,
  Modal.ScaleFunctionHttp,
  Modal.FetchServerHttp,
  Modal.ReadServerHttp,
  Modal.ReadAppHttp,
  Modal.WriteAppHttp,
);

/**
 * Answer with the upstream's status and body, so a cold Server's
 * `no upstreams available` reaches the test as a retryable failure.
 */
const relay = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  return yield* HttpServerResponse.json(yield* response.json, { status: response.status });
});

/** A Lambda function calling Modal Functions and Servers through their bindings. */
export default class ServicesFunction extends AWS.Lambda.Function<ServicesFunction>()(
  "ModalServicesFunction",
  { main: import.meta.url, timeout: Duration.minutes(14), memorySize: 1024 },
  Effect.gen(function* () {
    const embed = yield* Modal.InvokeFunction(Embed);
    const relayer = yield* Modal.InvokeFunction(Relay);
    const asyncEmbed = yield* Modal.InvokeFunction(AsyncEmbed);
    const readEmbed = yield* Modal.ReadFunction(Embed);
    const scaleEmbed = yield* Modal.ScaleFunction(Embed);
    const api = yield* Modal.FetchServer(Api);
    const web = yield* Modal.FetchServer(Web);
    const readApi = yield* Modal.ReadServer(Api);
    const services = yield* Modal.ReadApp(Services);
    const operate = yield* Modal.WriteApp(Services);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://host");
        switch (url.pathname) {
          case "/call":
            return yield* HttpServerResponse.json(yield* embed.embed("hello modal world"));
          case "/call-fails": {
            const failed = yield* embed.fail("asked to fail").pipe(Effect.flip);
            return yield* HttpServerResponse.json(failed);
          }
          case "/call-stream":
            return yield* HttpServerResponse.json(yield* Stream.runCollect(embed.count(3)));
          case "/map":
            return yield* HttpServerResponse.json(
              yield* asyncEmbed.map([["a"], ["b c"], ["d e f"]]),
            );
          case "/spawn": {
            const job = yield* asyncEmbed.spawn(["one two"]);
            return yield* HttpServerResponse.json(yield* asyncEmbed.result(job));
          }
          case "/call-async":
            return yield* HttpServerResponse.json(
              yield* asyncEmbed.call(["ping"], { source: "lambda" }),
            );
          case "/relay":
            return yield* HttpServerResponse.json(yield* relayer.relay("from modal"));
          case "/server-rpc-without-key": {
            // An RPC request through proxy auth, without this binding's key.
            const response = yield* api.fetch(
              HttpClientRequest.post("/__rpc__/greet").pipe(
                HttpClientRequest.bodyText(JSON.stringify(["intruder"]), "application/json"),
              ),
            );
            return yield* HttpServerResponse.json({ status: response.status });
          }
          case "/server-rpc":
            return yield* HttpServerResponse.json({
              greeting: yield* api.greet("modal"),
              letters: yield* Stream.runCollect(api.letters("abc")),
            });
          case "/server":
            return yield* relay(yield* api.fetch(HttpClientRequest.get("/hello")));
          case "/web":
            return yield* relay(yield* web.fetch(HttpClientRequest.get("/hello")));
          case "/read-function": {
            const stats = yield* readEmbed.stats();
            const { buckets } = yield* readEmbed.callCount({ since: Date.now() - 3_600_000 });
            const calls = (buckets ?? []).reduce((sum, b) => sum + Number(b.count ?? 0), 0);
            const autoscaler = yield* readEmbed.autoscaler();
            return yield* HttpServerResponse.json({ stats, calls, autoscaler });
          }
          case "/scale": {
            const settings = yield* scaleEmbed.update({ scaledownWindow: 120 });
            return yield* HttpServerResponse.json(settings ?? null);
          }
          case "/read-server": {
            const requests = yield* readApi.requests({ limit: 10 });
            const containers = yield* readApi.containers();
            return yield* HttpServerResponse.json({ requests, containers: containers.length });
          }
          case "/read-app": {
            const layout = yield* services.layout();
            const logs = yield* services.logs({ since: Date.now() - 3_600_000, limit: 50 });
            const deployments = yield* services.deployments();
            const tail = yield* services.tail({ timeout: 2 });
            return yield* HttpServerResponse.json({
              functions: Object.keys(layout.functionIds).sort(),
              logs: logs.length,
              tail: Array.isArray(tail.lines),
              version: deployments.productionAppVersion,
            });
          }
          case "/rollover": {
            yield* operate.rollover();
            return yield* HttpServerResponse.json({ rolled: true });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(BindingsLive)),
) {}
