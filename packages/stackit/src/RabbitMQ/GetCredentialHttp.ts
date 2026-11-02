import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetCredential } from "./GetCredential.ts";

/**
 * HTTP implementation of {@link GetCredential}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetCredential
 */
export const GetCredentialHttp = Layer.effect(
  GetCredential,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.GetCredential",
    permission: "rabbitmq.credential.get",
    operation: rabbitmq.getCredentials,
  }),
);
