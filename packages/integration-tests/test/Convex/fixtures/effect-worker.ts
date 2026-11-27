import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import {
  AddMessage,
  AddThenFail,
  GetMessage,
  ListMessages,
  Summarize,
  WhoAmI,
} from "./effect/src/messages.ts";
import { EffectDeployment } from "./resources.ts";

type Failure = { readonly _tag: string; readonly message?: string };

/** Answers with the value, or the tag of a typed failure. */
const tagged = <A, R>(effect: Effect.Effect<A, Failure, R>) =>
  effect.pipe(
    Effect.map((value): { value?: A; tag?: string; message?: string } => ({ value })),
    Effect.catch((error) => Effect.succeed({ tag: error._tag, message: error.message })),
    Effect.flatMap((body) => HttpServerResponse.json(body)),
  );

export default class ConvexEffectWorker extends Cloudflare.Worker<ConvexEffectWorker>()(
  "ConvexEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const query = yield* Convex.RunQuery(EffectDeployment);
    const mutation = yield* Convex.RunMutation(EffectDeployment);
    const action = yield* Convex.RunAction(EffectDeployment);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/add":
            return yield* tagged(
              mutation(AddMessage, { channel: param("channel"), body: param("body") }),
            );
          case "/add-then-fail":
            return yield* tagged(mutation(AddThenFail, { channel: param("channel") }));
          case "/list":
            return yield* tagged(
              query(ListMessages, { channel: param("channel") }).pipe(
                Effect.map((messages) =>
                  messages.map((message) => ({
                    id: message._id,
                    body: message.body,
                    delivered: message.delivered ?? false,
                    sentAtIsDate: message.sentAt instanceof Date,
                  })),
                ),
              ),
            );
          case "/get":
            return yield* tagged(
              query(GetMessage, { id: param("id") as typeof AddMessage.returns.Type }).pipe(
                Effect.map((message) => message._tag),
              ),
            );
          case "/summarize":
            return yield* tagged(action(Summarize, { channel: param("channel") }));
          case "/whoami":
            return yield* tagged(query(WhoAmI, {}));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Convex.RunQueryHttp, Convex.RunMutationHttp, Convex.RunActionHttp),
    ),
  ),
) {}
