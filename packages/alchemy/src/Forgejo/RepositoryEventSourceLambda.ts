import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Function } from "../AWS/Lambda/Function.ts";
import {
  isFunctionURLEvent,
  makeFunctionHttpHandler,
} from "../AWS/Lambda/HttpServer.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";
import {
  RepositoryEventSource,
  type RepositoryEventSourceProps,
  type RepositoryEvent,
} from "./RepositoryEventSource.ts";
import { makeForgejoSubscription } from "./RuntimeEvents.ts";

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
    return Effect.fn(function* (
      repo: Repository,
      props: RepositoryEventSourceProps,
      handler: (
        event: RepositoryEvent,
      ) => Effect.Effect<void, never, RuntimeContext>,
    ) {
      const subscription = yield* makeForgejoSubscription(
        `${host.Type}:${host.FQN}`,
        host.functionUrl,
        repo,
        props,
        host,
      );
      const receive = makeFunctionHttpHandler(
        Effect.gen(function* () {
          const incoming = yield* HttpServerRequest.HttpServerRequest;
          const request = yield* HttpServerRequest.toWeb(incoming).pipe(
            Effect.orDie,
          );
          const response = yield* subscription.handle(request, handler);
          return HttpServerResponse.fromWeb(response);
        }),
      );
      yield* host.listen((event) => {
        if (!isFunctionURLEvent(event) || event.rawPath !== subscription.path)
          return;
        return receive(event);
      });
    });
  }),
);
