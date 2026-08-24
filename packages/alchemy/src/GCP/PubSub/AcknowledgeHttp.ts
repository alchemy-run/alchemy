import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Acknowledge } from "./Acknowledge.ts";
import type { Subscription } from "./Subscription.ts";

/**
 * HTTP implementation of {@link Acknowledge}.
 *
 * @layer
 * @provides GCP.PubSub.Acknowledge
 */
export const AcknowledgeHttp = Layer.effect(
  Acknowledge,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <S extends Subscription>(subscription: S) {
      const name = yield* subscription.name;
      return Effect.fn(`GCP.PubSub.Acknowledge(${subscription.LogicalId})`)(
        function* (
          request: Omit<
            pubsub.AcknowledgeProjectsSubscriptionsRequest,
            "subscription"
          >,
        ) {
          return yield* pubsub
            .acknowledgeProjectsSubscriptions({
              ...request,
              subscription: yield* name,
            })
            .pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
        },
      );
    });
  }),
);
