import * as Duration from "effect/Duration";
import path from "pathe";
import * as Lambda from "@/AWS/Lambda";
import { Approve, Checkout, Greet, Nap, Parent, WorkflowsLive } from "./workflows.ts";

const main = path.resolve(import.meta.dirname, "host.ts");

/** A Lambda durable function that runs the test workflows. */
export class TestWorkflows extends Lambda.WorkflowFunction<TestWorkflows>()("TestWorkflows", {
  workflows: [Greet, Nap, Approve, Checkout, Parent],
}) {}

export default TestWorkflows.make(
  {
    main,
    executionTimeout: Duration.hours(1),
    retentionPeriod: "1 day",
    timeout: Duration.seconds(60),
  },
  WorkflowsLive,
);
