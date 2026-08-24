import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Publish } from "./Publish.ts";
import type { Topic } from "./Topic.ts";

/**
 * HTTP implementation of {@link Publish}.
 *
 * @layer
 * @provides GCP.PubSub.Publish
 */
export const PublishHttp = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends Topic>(topic: T) {
      const name = yield* topic.name;
      return Effect.fn(`GCP.PubSub.Publish(${topic.LogicalId})`)(function* (
        request: Omit<pubsub.PublishProjectsTopicsRequest, "topic">,
      ) {
        return yield* pubsub
          .publishProjectsTopics({
            ...request,
            topic: yield* name,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
