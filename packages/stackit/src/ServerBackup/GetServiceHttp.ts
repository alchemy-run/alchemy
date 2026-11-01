import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetService } from "./GetService.ts";

/**
 * HTTP implementation of {@link GetService}.
 *
 * @layer
 * @provides Stackit.ServerBackup.GetService
 */
export const GetServiceHttp = Layer.effect(
  GetService,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.GetService",
    access: { permissions: ["server-backup.service.get"] },
    operation: serverBackup.getServiceResource,
  }),
);
