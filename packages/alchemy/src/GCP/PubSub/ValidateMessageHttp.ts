import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Schema } from "./Schema.ts";
import {
  ValidateMessage,
  type ValidateMessageRequest,
} from "./ValidateMessage.ts";

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
    const validate = yield* pubsub.validateMessageProjectsSchemas.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (schema: Schema) {
      const name = yield* schema.name;
      const project = yield* schema.project;
      return Effect.fn(`GCP.PubSub.ValidateMessage(${schema.LogicalId})`)(
        function* (request: ValidateMessageRequest) {
          return yield* validate({
            parent: `projects/${yield* project}`,
            body: {
              ...request,
              name: yield* name,
            },
          });
        },
      );
    });
  }),
);
