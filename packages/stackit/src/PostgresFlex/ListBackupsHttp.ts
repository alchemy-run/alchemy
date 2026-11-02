import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.ListBackups",
    access: { permissions: ["postgres-flex.backup.list"] },
    operation: postgres.listBackups,
  }),
);
