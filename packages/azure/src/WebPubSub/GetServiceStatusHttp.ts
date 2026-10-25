import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeServiceOperationBinding } from "./BindingHttp.ts";
import { GetServiceStatus } from "./GetServiceStatus.ts";

/**
 * Implementation of {@link GetServiceStatus} over the distilled
 * `webpubsub-data` data plane. Assigns no role.
 *
 * @layer
 * @provides Azure.WebPubSub.GetServiceStatus
 */
export const GetServiceStatusHttp = Layer.effect(
  GetServiceStatus,
  makeServiceOperationBinding({
    tag: "Azure.WebPubSub.GetServiceStatus",
    operation: webpubsub.GetServiceStatus,
  }),
);
