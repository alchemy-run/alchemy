import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_LIST_ACCESS, makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListDistributions } from "./ListDistributions.ts";

/**
 * HTTP implementation of {@link ListDistributions}.
 *
 * @layer
 * @provides Stackit.CDN.ListDistributions
 */
export const ListDistributionsHttp = Layer.effect(
  ListDistributions,
  makeScopeHttpBinding({
    tag: "Stackit.CDN.ListDistributions",
    access: CDN_LIST_ACCESS,
    operation: cdn.listDistributions,
  }),
);
