import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetService } from "./GetService.ts";

/**
 * HTTP implementation of {@link GetService}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.GetService
 */
export const GetServiceHttp = Layer.effect(
  GetService,
  makeServerHttpBinding({
    tag: "Stackit.ServerUpdate.GetService",
    access: { permissions: ["server-update.service.get"] },
    operation: serverUpdate.getServiceResource,
  }),
);
