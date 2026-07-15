import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { StopReplicationTask } from "./StopReplicationTask.ts";

export const StopReplicationTaskHttp = Layer.effect(
  StopReplicationTask,
  makeDmsAccountHttpBinding<
    dms.StopReplicationTaskMessage,
    dms.StopReplicationTaskResponse,
    dms.StopReplicationTaskError
  >({
    tag: "AWS.DMS.StopReplicationTask",
    actions: ["dms:StopReplicationTask"],
    operation: dms.stopReplicationTask,
  }),
);
