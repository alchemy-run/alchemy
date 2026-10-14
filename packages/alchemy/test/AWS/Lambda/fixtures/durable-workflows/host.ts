import * as Duration from "effect/Duration";
import path from "pathe";
import * as Lambda from "@/AWS/Lambda";
import { WorkflowsLive } from "./workflows.ts";

const main = path.resolve(import.meta.dirname, "host.ts");

/** A durable function that hosts the test workflows. */
export class WorkflowHostFunction extends Lambda.DurableFunction<WorkflowHostFunction>()(
  "WorkflowHostFunction",
) {}

export default WorkflowHostFunction.make(
  {
    main,
    executionTimeout: Duration.hours(1),
    retentionPeriod: "1 day",
    timeout: Duration.seconds(60),
  },
  Lambda.WorkflowHost(WorkflowsLive),
);
