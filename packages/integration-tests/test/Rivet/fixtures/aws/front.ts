/** The HTTP front of the AWS conformance suite: a Lambda calling the counter through the gateway. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { ChatLog } from "../chat-log.ts";
import { Counter } from "../counter-declaration.ts";
import { Services } from "./cluster.ts";

export default class Front extends Lambda.Function<Front>()(
  "RivetAwsFront",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const counters = yield* Counter;
    const chat = yield* ChatLog;
    const conformance = conformanceFetch(counters);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [group, key] = new URL(request.url, "http://front").pathname
          .split("/")
          .filter((segment) => segment.length > 0);
        // `/durable-stream/<key>`: append two messages, then read the stream back.
        if (group === "durable-stream" && key !== undefined) {
          yield* chat.appendAll(key, [
            { user: "a", text: "one" },
            { user: "b", text: "two" },
          ]);
          return yield* HttpServerResponse.json(yield* chat.read(key));
        }
        return yield* conformance;
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
