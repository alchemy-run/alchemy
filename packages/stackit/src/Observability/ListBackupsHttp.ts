import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.Observability.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListBackups",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listBackups,
  }),
);
