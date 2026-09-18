import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Repository } from "../../Forgejo/Repository.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  RepositoryEventSource,
  type RepositoryEventSourceProps,
  type RepositoryEvent,
} from "../../Forgejo/RepositoryEventSource.ts";
import { makeForgejoSubscription } from "../../Forgejo/RuntimeEvents.ts";
import { Function } from "./Function.ts";
import { isFunctionURLEvent, makeFunctionHttpHandler } from "./HttpServer.ts";

/** Lambda Function URL / API Gateway v2 listener for signed Forgejo events. */
export const ForgejoRepositoryEventSourceLive = Layer.effect(
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
