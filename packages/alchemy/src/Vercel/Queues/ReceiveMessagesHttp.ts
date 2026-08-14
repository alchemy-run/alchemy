import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isFunction } from "../Functions/Function.ts";
import { topicEnvKey, topicEnvValue } from "./QueueClient.ts";
import {
  makeReceiveMessagesClient,
  ReceiveMessages,
  type ReceiveMessagesClient,
  type ReceiveMessagesOptions,
} from "./ReceiveMessages.ts";
import type { Topic } from "./Topic.ts";

/**
 * HTTP (OIDC data-plane) implementation of {@link ReceiveMessages}.
 *
 * Deploy half (guarded by `__ALCHEMY_RUNTIME__`): registers the topic's env
 * refs on the host Function. Runtime half: the poll-mode consumer client,
 * authenticated with the ambient OIDC token and pinned to
 * `VERCEL_DEPLOYMENT_ID` unless the topic is `partition: "shared"`.
 *
 * ## Runtime authorization
 *
 * Same story as `SendMessageHttp`: the **ambient per-deployment OIDC
 * token** (request-context `x-vercel-oidc-token`, then
 * `VERCEL_OIDC_TOKEN`) authorizes the consumer — nothing is minted or
 * synced by alchemy, and the deploy half binds only non-secret topic
 * metadata. Consumers running OUTSIDE Vercel mint a development-scoped
 * project OIDC token via `projects.getProjectToken`
 * (`mintProjectOidcToken` / `projectOidcToken` in `OidcToken.ts`); minted
 * tokens are always `environment: development`-scoped, a namespace
 * disjoint from deployed production traffic.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.ReceiveMessagesHttp)`.
 */
export const ReceiveMessagesHttp: Layer.Layer<
  ReceiveMessages,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ReceiveMessages,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return Effect.fn(function* (
      topic: Topic<Schema.Top>,
      options: ReceiveMessagesOptions,
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`ReceiveMessages(${host}, ${topic.topicName})`({
            env: { [topicEnvKey(topic)]: topicEnvValue(topic) },
          });
        }
      }
      const client = yield* makeReceiveMessagesClient(topic, options).pipe(
        Effect.provideContext(context),
      );
      // Widening to the RuntimeContext-colored interface is safe (R is
      // contravariant); the ambient-token client only functions inside a
      // deployed Vercel Function anyway.
      return client as ReceiveMessagesClient<Schema.Top, RuntimeContext>;
    });
  }),
);
