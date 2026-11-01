import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListACL } from "./ListACL.ts";

/**
 * HTTP implementation of {@link ListACL}.
 *
 * @layer
 * @provides Stackit.Observability.ListACL
 */
export const ListACLHttp = Layer.effect(
  ListACL,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListACL",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listACL,
  }),
);
