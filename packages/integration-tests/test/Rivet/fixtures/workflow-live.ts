/** The conformance workflows on Rivet Durable Objects. */
import * as Rivet from "@alchemy.run/rivet";
import * as Layer from "effect/Layer";
import { WorkflowsLive } from "../../Workflows/conformance/workflows.ts";
import { WorkflowPool } from "./workflow-cluster.ts";
import { JournalLive } from "./workflow-journal.ts";

// The pool's nodes load this export to run the workflows.
export const WorkflowsRivetLive = WorkflowsLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Rivet.layerWorkflowEngine({
        name: "WorkflowExecutions",
        main: import.meta.url,
        handler: "WorkflowsRivetLive",
        pool: WorkflowPool,
      }),
      JournalLive,
    ),
  ),
);
