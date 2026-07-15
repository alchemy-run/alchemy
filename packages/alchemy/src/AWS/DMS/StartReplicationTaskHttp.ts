import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { StartReplicationTask } from "./StartReplicationTask.ts";

export const StartReplicationTaskHttp = Layer.effect(
  StartReplicationTask,
  makeDmsAccountHttpBinding<
    dms.StartReplicationTaskMessage,
    dms.StartReplicationTaskResponse,
    dms.StartReplicationTaskError
  >({
    tag: "AWS.DMS.StartReplicationTask",
    actions: ["dms:StartReplicationTask"],
    operation: dms.startReplicationTask,
  }),
);
