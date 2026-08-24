import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Schema } from "./Schema.ts";
import { ValidateMessage } from "./ValidateMessage.ts";

/**
 * HTTP implementation of {@link ValidateMessage}.
 *
 * @layer
 * @provides GCP.PubSub.ValidateMessage
 */
export const ValidateMessageHttp = Layer.effect(
  ValidateMessage,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <S extends Schema>(schema: S) {
      const name = yield* schema.name;
      const project = yield* schema.project;
      return Effect.fn(`GCP.PubSub.ValidateMessage(${schema.LogicalId})`)(
        function* (
          request: Omit<pubsub.ValidateMessageRequest, "name" | "schema">,
        ) {
          return yield* pubsub
            .validateMessageProjectsSchemas({
              parent: `projects/${yield* project}`,
              body: {
                ...request,
                name: yield* name,
              },
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
