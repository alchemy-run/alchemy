import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DownloadBackup } from "./DownloadBackup.ts";

/**
 * HTTP implementation of {@link DownloadBackup}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.DownloadBackup
 */
export const DownloadBackupHttp = Layer.effect(
  DownloadBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.DownloadBackup",
    permission: "rabbitmq.proxy.read",
    operation: rabbitmq.downloadBackup,
  }),
);
