import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { deployWarehouse } from "../fixtures/bindings-warehouse.ts";
import {
  cloudflareSkipReason,
  PRUNE_ORDERS,
  PruneOrders,
  WAREHOUSES,
} from "../fixtures/bindings.ts";
import { getJson } from "../fixtures/http.ts";
import GalaxySqlJobWorker from "../fixtures/sql-job-worker.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers(), Cloudflare.providers()),
});

const named = (title: string) =>
  cloudflareSkipReason ? `${title} [skipped: ${cloudflareSkipReason}]` : title;

interface Status {
  readonly sqlJobId: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly errorMessage: string | null;
}

test.provider.skipIf(!!cloudflareSkipReason)(
  named("a Worker runs a SQL job on the warehouse, follows it to Completed, and reads its history"),
  (stack) =>
    Effect.gen(function* () {
      // The warehouse in its own stack, destroyed after this one: the job's cluster attaches it through a lookup.
      yield* deployWarehouse(WAREHOUSES.sqlJob);
      yield* freshStack(stack);
      const { url, sqlJobId } = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* PruneOrders;
          const worker = yield* GalaxySqlJobWorker;
          return { url: worker.url.as<string>(), sqlJobId: job.sqlJobId };
        }),
      );

      const before = yield* getJson<Status>(url, "/status");
      expect(before.sqlJobId).toBe(sqlJobId);
      yield* getJson<{ started: boolean }>(url, "/execute");

      // The run starts the suspended cluster first: up to ten minutes.
      const finished = yield* getJson<Status>(url, "/status").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
          until: (status) =>
            status.updatedAt !== before.updatedAt &&
            (status.status === "Completed" || status.status === "Failed"),
        }),
      );
      expect({ status: finished.status, error: finished.errorMessage }).toEqual({
        status: "Completed",
        error: null,
      });

      const history = yield* getJson<{ runs: Array<{ status: string; queries: string[] }> }>(
        url,
        "/history",
      );
      expect(history.runs.some((run) => run.status === "Completed")).toBe(true);
      expect(history.runs[0]?.queries).toEqual([PRUNE_ORDERS]);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:sql-jobs",
      "provider:neon",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 1_200_000,
  },
);
