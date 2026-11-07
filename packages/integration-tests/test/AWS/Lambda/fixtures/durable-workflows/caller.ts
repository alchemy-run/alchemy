import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import path from "pathe";
import { app } from "../../../../Workflows/conformance/app.ts";
import { ChargeHandler } from "../../../../Workflows/conformance/workflows.ts";
import { Charges, TestWorkflows } from "./host.ts";
import { JournalLive } from "./journal.ts";

const main = path.resolve(import.meta.dirname, "caller.ts");

/**
 * A plain Lambda function that serves the conformance app over TestWorkflows,
 * and works the workflows' queue items.
 */
export class WorkflowCaller extends Lambda.Function<WorkflowCaller>()("WorkflowCaller") {}

export default WorkflowCaller.make(
  { main, functionUrl: true, timeout: Duration.seconds(60) },
  Effect.gen(function* () {
    const charges = yield* Charges;
    return yield* app.pipe(
      Effect.provide(
        Lambda.DurableQueueWorker(charges, [ChargeHandler]).pipe(
          Layer.provideMerge(
            Layer.mergeAll(Lambda.DurableFunctionEngine(TestWorkflows), JournalLive),
          ),
        ),
      ),
    );
  }),
);
