import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestoreJobs } from "./ListRestoreJobs.ts";

/**
 * HTTP implementation of {@link ListRestoreJobs}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ListRestoreJobs
 */
export const ListRestoreJobsHttp = Layer.effect(
  ListRestoreJobs,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.ListRestoreJobs",
    access: { permissions: ["sqlserver-flex.restore.list"] },
    operation: sqlserver.listCurrentRunningRestoreJobs,
  }),
);
