import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Embed from "./Embed.ts";
import { Inference } from "./Inference.ts";

/** A web function that calls `Embed` for each request. */
export default class Api extends Modal.Function<Api>()(
  "Api",
  { main: import.meta.url, app: Inference, web: true },
  Effect.gen(function* () {
    const embed = yield* Modal.InvokeFunction(Embed);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const text = new URL(request.url, "http://api").searchParams.get("text") ?? "";
        const result = yield* embed.embed(text);
        return yield* HttpServerResponse.json({ text, ...result });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.InvokeFunctionHttp)),
) {}
