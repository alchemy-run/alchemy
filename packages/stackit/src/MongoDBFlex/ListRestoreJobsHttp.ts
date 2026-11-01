import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestoreJobs } from "./ListRestoreJobs.ts";

/**
 * HTTP implementation of {@link ListRestoreJobs}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ListRestoreJobs
 */
export const ListRestoreJobsHttp = Layer.effect(
  ListRestoreJobs,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ListRestoreJobs",
    access: { permissions: ["mongodb-flex.backup.restore-list"] },
    operation: mongodb.listRestoreJobs,
  }),
);
