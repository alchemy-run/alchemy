import * as Azure from "@alchemy.run/azure";
import { distilledFromSource } from "../distilled-source.ts";
import { Approve, Checkout, Greet, Nap, Parent, WorkflowsLive } from "./workflows.ts";

/** Durable Task Schedulers are not offered in eastus; keep the whole test in one region. */
export const LOCATION = "westus2";

/** An Azure Function that runs the test workflows on Durable Functions. */
export class TestWorkflows extends Azure.Functions.WorkflowFunction<TestWorkflows>()(
  "TestWorkflows",
  { workflows: [Greet, Nap, Approve, Checkout, Parent], schedulerLocation: LOCATION },
) {}

export default TestWorkflows.make(
  {
    main: import.meta.url,
    location: LOCATION,
    build: { input: { plugins: [distilledFromSource] } },
  },
  WorkflowsLive,
);
