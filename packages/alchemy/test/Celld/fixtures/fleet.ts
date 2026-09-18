import * as Celld from "@/Celld";
import { Namespace } from "@/Namespace";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The fleet: infrastructure only (nodes + bucket via the registered host).
 *
 * THREE nodes on purpose: the fleet URL is Cloud Map DNS round-robin over
 * every node, so the conformance run (and the dedicated affinity test)
 * exercises celld's any-node-forwards-to-the-lease-owner routing — a
 * single-node fleet would never leave the owner.
 */
export class ConformanceCells extends Celld.Fleet<ConformanceCells>()(
  "ConformanceCells",
  { instances: 3 },
) {}

/**
 * The Celld worker tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the Lambda caller ([api.ts](./api.ts))
 * stay acyclic — the caller imports only this tag, never the impl.
 */
export class ConformanceWorker extends Celld.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}

/** Shared root publication, including when referenced from the Lambda's scope. */
const application = Celld.Application("ConformanceApp", {
  entrypoint: ConformanceWorker,
}).pipe(Effect.provide(Celld.Fleet.layer(ConformanceCells)));

export const ConformanceApplication = application.pipe(
  Effect.updateContext(
    (context: Context.Context<Effect.Services<typeof application>>) =>
      Context.omit(Namespace)(context),
  ),
);
