import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as edge from "@distilled.cloud/stackit/edge";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, MISSING_INSTANCE_ID, observeInstance, planId, slow } from "./edge.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("edgecloud", "kubeconfig"), timeout: 1_800_000 } as const;

const program = (props: { expirationSeconds: number; refreshBeforeSeconds?: number }) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.EdgeCloud.Instance("KubeconfigInstance", { planId });
    const access = yield* Stackit.EdgeCloud.Kubeconfig("Access", {
      instanceId: instance.instanceId,
      ...props,
    });
    return { instanceId: instance.instanceId, access };
  });

// Ungated: nothing is created. No test here has run: no STACKIT account exists yet.
test.provider(
  "a kubeconfig of a missing instance fails with the typed NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const failed = yield* stack
        .deploy(Stackit.EdgeCloud.Kubeconfig("Orphan", { instanceId: MISSING_INSTANCE_ID }))
        .pipe(Effect.flip);
      expect(failed._tag).toEqual("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: options.tags, timeout: 120_000 },
);

test.provider.skipIf(slow)(
  "mints, keeps and re-mints a kubeconfig",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ expirationSeconds: 3600 }));
      const access = first.access;

      // The secret stays wrapped, and is a kubeconfig once opened.
      expect(Redacted.isRedacted(access.kubeconfig)).toBe(true);
      const parsed = JSON.parse(Redacted.value(access.kubeconfig));
      expect(parsed.clusters.length).toBeGreaterThan(0);

      // It expires an hour after it was minted.
      expect(new Date(access.expiresAt).getTime() - new Date(access.mintedAt).getTime()).toEqual(
        3600 * 1000,
      );

      // Out of band: the instance it belongs to, and the SDK's sensitive mark.
      const instance = yield* edge.getInstance({
        projectId,
        regionId: region,
        instanceId: access.instanceId,
      });
      expect(instance.created).toEqual(access.instanceCreated);
      const direct = yield* edge.getKubeconfigByInstanceId({
        projectId,
        regionId: region,
        instanceId: access.instanceId,
        expirationSeconds: 600,
      });
      expect(Redacted.isRedacted(direct.kubeconfig)).toBe(true);

      // Still good: a redeploy is a no-op and keeps it.
      const plan = yield* stack.plan(program({ expirationSeconds: 3600 }));
      expect(plan.resources.Access).toMatchObject({ action: "noop" });

      // A refresh window wider than what's left means expiring: it is re-minted in place,
      // with a later expiry.
      const refreshed = yield* stack.deploy(
        program({ expirationSeconds: 3600, refreshBeforeSeconds: 3600 }),
      );
      expect(new Date(refreshed.access.expiresAt).getTime()).toBeGreaterThan(
        new Date(access.expiresAt).getTime(),
      );

      // A different lifetime is a different kubeconfig.
      const longer = yield* stack.deploy(program({ expirationSeconds: 7200 }));
      expect(longer.access.expirationSeconds).toEqual(7200);
      expect(new Date(longer.access.expiresAt).getTime()).toBeGreaterThan(
        new Date(refreshed.access.expiresAt).getTime(),
      );

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, access.instanceId));
    }).pipe(logLevel),
  options,
);
