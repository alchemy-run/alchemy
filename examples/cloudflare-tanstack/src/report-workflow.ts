// Narrow subpath imports (never the `alchemy/Cloudflare` barrel).
import * as KV from "alchemy/Cloudflare/KV";
import * as Workflows from "alchemy/Cloudflare/Workflows";
import * as Effect from "effect/Effect";
import { Visits } from "./resources.ts";

/**
 * Durable Workflow registered by `yield* ReportWorkflow` in the backend —
 * the binding, the workflow config, and the class export in the generated
 * worker entry all derive from that one registration.
 *
 * Two durable steps around a short sleep; the second step writes the
 * result to KV so completion is observable from the outside (the integ
 * test polls the workflow status AND the KV marker).
 */
export default class ReportWorkflow extends Workflows.Workflow<ReportWorkflow>()(
  "ReportWorkflow",
  Effect.gen(function* () {
    const kv = yield* KV.ReadWriteNamespace(Visits);
    return Effect.fn(function* (input: { marker: string }) {
      const greeting = yield* Workflows.task(
        "compose",
        Effect.succeed(`report:${input.marker}`),
        { retries: { limit: 3, delay: "1 second", backoff: "linear" } },
      );
      yield* Workflows.sleep("pause", "1 second");
      yield* Workflows.task(
        "deliver",
        kv.put("workflow-last", greeting).pipe(Effect.orDie),
      );
      return greeting;
    });
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
