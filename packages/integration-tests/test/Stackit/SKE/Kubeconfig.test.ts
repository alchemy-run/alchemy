import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLUSTER_TEST_TIMEOUT, expectClusterGone, slow, smallPool } from "./cluster.ts";

const { test } = makeStackitTest();

// `blocked: cost`. Needs a cluster: about EUR 0.48 per run. Gated behind
// STACKIT_TEST_SLOW.
const options = { tags: stackitTags("ske", "kubeconfig"), timeout: CLUSTER_TEST_TIMEOUT } as const;

const program = (props: { expirationSeconds: number; refreshBeforeSeconds?: number }) =>
  Effect.gen(function* () {
    const cluster = yield* Stackit.SKE.Cluster("KubeconfigCluster", { nodepools: [smallPool] });
    const access = yield* Stackit.SKE.Kubeconfig("Access", {
      clusterName: cluster.clusterName,
      ...props,
    });
    return { clusterName: cluster.clusterName, access };
  });

test.provider.skipIf(slow)(
  "mints, keeps and re-mints a kubeconfig",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ expirationSeconds: 3600 }));
      const access = first.access;

      // The secret stays wrapped, and holds a server to connect to.
      expect(Redacted.isRedacted(access.kubeconfig)).toBe(true);
      const parsed = Stackit.SKE.parseKubeconfig(Redacted.value(access.kubeconfig));
      expect(parsed?.endpoint).toMatch(/^https:\/\//);
      expect(parsed?.token !== undefined || parsed?.clientCert !== undefined).toBe(true);

      // It expires an hour after it was minted, by the API's clock.
      const lifetime =
        new Date(access.expirationTimestamp).getTime() - new Date(access.mintedAt).getTime();
      expect(lifetime).toEqual(3600 * 1000);

      // Still good: a redeploy is a no-op and keeps it.
      const plan = yield* stack.plan(program({ expirationSeconds: 3600 }));
      expect(plan.resources.Access).toMatchObject({ action: "noop" });

      // A refresh window wider than what's left means expiring: it is re-minted
      // in place, with a later expiry.
      const refreshed = yield* stack.deploy(
        program({ expirationSeconds: 3600, refreshBeforeSeconds: 3600 }),
      );
      expect(new Date(refreshed.access.expirationTimestamp).getTime()).toBeGreaterThan(
        new Date(access.expirationTimestamp).getTime(),
      );
      expect(Redacted.value(refreshed.access.kubeconfig)).not.toEqual(
        Redacted.value(access.kubeconfig),
      );

      // A different lifetime replaces it.
      const replaced = yield* stack.deploy(program({ expirationSeconds: 1800 }));
      const replacedLifetime =
        new Date(replaced.access.expirationTimestamp).getTime() -
        new Date(replaced.access.mintedAt).getTime();
      expect(replacedLifetime).toEqual(1800 * 1000);

      // Destroying it forgets it; the API has no revoke to verify.
      yield* stack.destroy();
      yield* expectClusterGone(projectId, region, first.clusterName);
      const { items } = yield* ske.listClusters({ projectId, region });
      expect(items?.map((item) => item.name) ?? []).not.toContain(first.clusterName);
    }).pipe(logLevel),
  options,
);
