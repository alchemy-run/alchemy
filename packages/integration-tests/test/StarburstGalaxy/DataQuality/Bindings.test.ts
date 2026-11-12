import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { deployWarehouse } from "../fixtures/bindings-warehouse.ts";
import { cloudflareSkipReason, OrdersCheck, WAREHOUSES } from "../fixtures/bindings.ts";
import { getJson } from "../fixtures/http.ts";
import GalaxyQualityWorker from "../fixtures/quality-worker.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers(), Cloudflare.providers()),
});

const named = (title: string) =>
  cloudflareSkipReason ? `${title} [skipped: ${cloudflareSkipReason}]` : title;

interface Latest {
  readonly dataQualityCheckId: string;
  readonly evaluatedAt: string | null;
  readonly status: string | null;
}

test.provider.skipIf(!!cloudflareSkipReason)(
  named("a Worker evaluates a SQL check, follows it to Success, and reads the quality metrics"),
  (stack) =>
    Effect.gen(function* () {
      // The warehouse in its own stack, destroyed after this one: the check and the Worker bind it through a lookup.
      yield* deployWarehouse(WAREHOUSES.quality);
      yield* freshStack(stack);
      const { url, checkId } = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* OrdersCheck;
          const worker = yield* GalaxyQualityWorker;
          return { url: worker.url.as<string>(), checkId: check.dataQualityCheckId };
        }),
      );

      const requestedAt = new Date();
      yield* getJson<{ requested: boolean }>(url, "/evaluate");

      // The evaluation starts the suspended cluster first: up to ten minutes.
      const latest = yield* getJson<Latest>(url, "/latest").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
          until: (found) =>
            found.evaluatedAt !== null && new Date(found.evaluatedAt) >= requestedAt,
        }),
      );
      expect(latest).toMatchObject({ dataQualityCheckId: checkId, status: "Success" });

      const evaluations = yield* getJson<{ statuses: string[] }>(url, "/evaluations");
      expect(evaluations.statuses).toContain("Success");

      const summary = yield* getJson<{
        account: number;
        catalog: number;
        schema: number;
        checks: string[];
      }>(url, "/summary");
      expect(summary.checks).toEqual([checkId]);
      expect(summary.account).toBeGreaterThan(0);
      expect(summary.catalog).toBeGreaterThan(0);
      expect(summary.schema).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:data-quality",
      "provider:neon",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 1_200_000,
  },
);
