import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Function } from "../AWS/Lambda/Function.ts";
import {
  isFunctionURLEvent,
  makeFunctionHttpHandler,
} from "../AWS/Lambda/HttpServer.ts";
import { RepositoryEventSource } from "./RepositoryEventSource.ts";
import { makeForgejoEventSource } from "./RuntimeEvents.ts";

/**
 * Receives signed Forgejo webhooks through a Lambda Function URL or API Gateway v2.
 *
 * @layer
 * @provides Forgejo.RepositoryEventSource
 */
export const RepositoryEventSourceLambda = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return yield* makeForgejoEventSource({
      host: `${host.Type}:${host.FQN}`,
      url: host.functionUrl,
      runtime: host,
      listen: (receiver) =>
        Effect.gen(function* () {
          const receive = makeFunctionHttpHandler(
            Effect.gen(function* () {
              const incoming = yield* HttpServerRequest.HttpServerRequest;
              const request = yield* HttpServerRequest.toWeb(incoming).pipe(
                Effect.orDie,
              );
              return HttpServerResponse.fromWeb(
                yield* receiver.handle(request),
              );
            }),
          );
          yield* host.listen((event) => {
            if (!isFunctionURLEvent(event) || event.rawPath !== receiver.path)
              return;
            return receive(event);
          });
        }),
    });
  }),
);
