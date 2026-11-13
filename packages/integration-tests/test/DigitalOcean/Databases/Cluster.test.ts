import * as DigitalOcean from "@alchemy.run/digitalocean";
import { hashOwnershipTag } from "@alchemy.run/digitalocean/internal/ownership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getDatabaseCluster } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { forgetAttributes, isGone, logLevel, skipSlow, testName } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:databases", "live"];
// A cluster takes five to ten minutes to come online.
const LIVE_TIMEOUT = 1_800_000;

test.provider.skipIf(skipSlow)(
  "cluster lifecycle: create postgres, retag in place, resume lost attributes, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = testName(stack.stage, "db");

      const declare = (tags: string[]) =>
        DigitalOcean.Databases.Cluster("Pg", {
          engine: "pg",
          size: "db-s-1vcpu-1gb",
          region: "nyc3",
          tags,
        });

      const created = yield* stack.deploy(declare([tag]));
      expect(created).toMatchObject({
        engine: "pg",
        status: "online",
        region: "nyc3",
        numNodes: 1,
      });
      expect(created.tags).toEqual([tag]);
      expect(created.host).toMatch(/db\.ondigitalocean\.com$/);
      expect(Redacted.value(created.uri!)).toMatch(/^postgresql:\/\/doadmin:/);
      const remote = yield* getDatabaseCluster({ database_cluster_uuid: created.clusterId });
      expect(remote.database.tags ?? []).toContain(
        yield* hashOwnershipTag(stack.name, stack.stage, "Pg"),
      );

      const retagged = yield* stack.deploy(declare([]));
      expect(retagged.clusterId).toEqual(created.clusterId);
      expect(retagged.tags).toEqual([]);

      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Pg" });
      expect((yield* stack.deploy(declare([]))).clusterId).toEqual(created.clusterId);

      yield* stack.destroy();

      expect(yield* isGone(getDatabaseCluster({ database_cluster_uuid: created.clusterId }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
