import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isFunction } from "../Functions/Function.ts";
import { topicEnvKey, topicEnvValue } from "./QueueClient.ts";
import {
  makeSendMessageClient,
  SendMessage,
  type SendMessageClient,
} from "./SendMessage.ts";
import type { Topic } from "./Topic.ts";

/**
 * HTTP (OIDC data-plane) implementation of {@link SendMessage}.
 *
 * Deploy half (guarded by `__ALCHEMY_RUNTIME__`): registers the topic's env
 * refs on the host Function — region, topic name, partition mode; never
 * tokens (the runtime OIDC token is platform-ambient). Runtime half: the
 * schema-typed producer client over `https://{region}.vercel-queue.com`,
 * authenticated with the ambient OIDC token and pinned to
 * `VERCEL_DEPLOYMENT_ID` unless the topic is `partition: "shared"`.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.SendMessageHttp)`.
 */
export const SendMessageHttp: Layer.Layer<
  SendMessage,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  SendMessage,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return Effect.fn(function* (topic: Topic<Schema.Top>) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`SendMessage(${host}, ${topic.topicName})`({
            env: { [topicEnvKey(topic)]: topicEnvValue(topic) },
          });
        }
      }
      const client = yield* makeSendMessageClient(topic).pipe(
        Effect.provideContext(context),
      );
      // Widening to the RuntimeContext-colored interface is safe: R is
      // contravariant, and the ambient-token client only functions inside a
      // deployed Vercel Function anyway.
      return client as SendMessageClient<Schema.Top, RuntimeContext>;
    });
  }),
);
