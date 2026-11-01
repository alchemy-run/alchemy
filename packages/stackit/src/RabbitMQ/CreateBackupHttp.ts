import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.CreateBackup",
    permission: "rabbitmq.proxy.write",
    operation: rabbitmq.createBackup,
  }),
);
