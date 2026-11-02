import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { brokerCaller } from "./BindingHttp.ts";
import type { Credential } from "./Credential.ts";
import { Publish, type PublishRequest } from "./Publish.ts";

/** What the management API calls the default exchange, whose real name is empty. */
const DEFAULT_EXCHANGE = "amq.default";

/**
 * HTTP implementation of {@link Publish}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.Publish
 */
export const PublishHttp = Layer.succeed(
  Publish,
  Effect.fn(function* (credential: Credential) {
    const call = yield* brokerCaller(credential);
    return Effect.fn(`Stackit.RabbitMQ.Publish(${credential.LogicalId})`)(function* (
      request: PublishRequest,
    ) {
      const vhost = request.vhost ?? (yield* call.vhost);
      return yield* call(management.publishMessage, {
        vhost,
        exchange:
          request.exchange === undefined || request.exchange === ""
            ? DEFAULT_EXCHANGE
            : request.exchange,
        routing_key: request.routing_key,
        payload: request.payload,
        payload_encoding: request.payload_encoding ?? "string",
        properties: request.properties ?? {},
      });
    });
  }),
);
