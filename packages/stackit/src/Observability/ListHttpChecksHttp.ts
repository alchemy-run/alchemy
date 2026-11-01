import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListHttpChecks } from "./ListHttpChecks.ts";

/**
 * HTTP implementation of {@link ListHttpChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListHttpChecks
 */
export const ListHttpChecksHttp = Layer.effect(
  ListHttpChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListHttpChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listHttpChecks,
  }),
);
