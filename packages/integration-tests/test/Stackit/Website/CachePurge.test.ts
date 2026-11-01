import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectDistributionGone } from "./site.ts";

const { test } = makeStackitTest();

// A distribution has no per-distribution fee and this sends it no traffic: under EUR 0.01
// per run (price list v1.0.44, EUR 0.00005/MB), ungated.
const options = { tags: stackitTags("website", "cachepurge"), timeout: 900_000 } as const;

const ORIGIN = "https://www.stackit.de";

test.provider(
  "purges only the paths that changed, and everything on request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { projectId } = yield* stackitEnvironment;

      const app = (props: { version: string; files: Record<string, string>; all?: boolean }) =>
        Effect.gen(function* () {
          const distribution = yield* Stackit.CDN.Distribution("PurgedDistribution", {
            backend: { type: "http", originUrl: ORIGIN },
          });
          const purge = yield* Stackit.Website.CachePurge("Purge", {
            distributionId: distribution.distributionId,
            projectId: distribution.projectId,
            ...props,
          });
          return { distribution, purge };
        });

      // A new distribution holds nothing, so there is nothing to purge.
      const first = yield* stack.deploy(
        app({ version: "1", files: { "/a": "one", "/b": "one", "/c": "one" } }),
      );
      expect(first.purge.purgedPaths).toEqual([]);

      // Only what changed or disappeared. A new path was never cached.
      const changed = yield* stack.deploy(
        app({ version: "2", files: { "/a": "two", "/b": "one", "/d": "one" } }),
      );
      expect(changed.purge.purgedPaths).toEqual(["/a", "/c"]);

      // Unchanged: nothing to do.
      const plan = yield* stack.plan(
        app({ version: "2", files: { "/a": "two", "/b": "one", "/d": "one" } }),
      );
      expect(plan.resources.Purge).toMatchObject({ action: "noop" });

      // `all` purges everything when the version changes.
      const all = yield* stack.deploy(
        app({ version: "3", files: { "/a": "two", "/b": "one", "/d": "one" }, all: true }),
      );
      expect(all.purge.purgedPaths).toEqual(["*"]);

      const site = {
        url: all.distribution.url as string,
        projectId,
        distributionId: all.distribution.distributionId,
        hostname: all.distribution.hostname,
      };
      yield* stack.destroy();
      yield* expectDistributionGone(site);
    }).pipe(logLevel),
  options,
);
