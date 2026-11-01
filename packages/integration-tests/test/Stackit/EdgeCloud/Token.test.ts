import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as edge from "@distilled.cloud/stackit/edge";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, MISSING_INSTANCE_ID, observeInstance, planId, slow } from "./edge.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("edgecloud", "token"), timeout: 1_800_000 } as const;

const program = (props: { expirationSeconds: number; refreshBeforeSeconds?: number }) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.EdgeCloud.Instance("TokenInstance", { planId });
    const token = yield* Stackit.EdgeCloud.Token("HostToken", {
      instanceId: instance.instanceId,
      ...props,
    });
    return { instanceId: instance.instanceId, token };
  });

// Ungated: nothing is created. No test here has run: no STACKIT account exists yet.
test.provider(
  "a token of a missing instance fails with the typed NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const failed = yield* stack
        .deploy(Stackit.EdgeCloud.Token("Orphan", { instanceId: MISSING_INSTANCE_ID }))
        .pipe(Effect.flip);
      expect(failed._tag).toEqual("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: options.tags, timeout: 120_000 },
);

test.provider.skipIf(slow)(
  "mints, keeps and re-mints a token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ expirationSeconds: 3600 }));
      const token = first.token;

      // The secret stays wrapped, and holds something once opened.
      expect(Redacted.isRedacted(token.token)).toBe(true);
      expect(Redacted.value(token.token).length).toBeGreaterThan(0);

      // It expires an hour after it was minted.
      expect(new Date(token.expiresAt).getTime() - new Date(token.mintedAt).getTime()).toEqual(
        3600 * 1000,
      );

      // Out of band: the instance it belongs to, and the SDK's sensitive mark.
      const instance = yield* edge.getInstance({
        projectId,
        regionId: region,
        instanceId: token.instanceId,
      });
      expect(instance.created).toEqual(token.instanceCreated);
      const direct = yield* edge.getTokenByInstanceId({
        projectId,
        regionId: region,
        instanceId: token.instanceId,
        expirationSeconds: 600,
      });
      expect(Redacted.isRedacted(direct.token)).toBe(true);

      // Still good: a redeploy is a no-op and keeps it.
      const plan = yield* stack.plan(program({ expirationSeconds: 3600 }));
      expect(plan.resources.HostToken).toMatchObject({ action: "noop" });

      // A refresh window wider than what's left means expiring: it is re-minted in place,
      // with a later expiry.
      const refreshed = yield* stack.deploy(
        program({ expirationSeconds: 3600, refreshBeforeSeconds: 3600 }),
      );
      expect(new Date(refreshed.token.expiresAt).getTime()).toBeGreaterThan(
        new Date(token.expiresAt).getTime(),
      );

      // A different lifetime is a different token.
      const longer = yield* stack.deploy(program({ expirationSeconds: 7200 }));
      expect(longer.token.expirationSeconds).toEqual(7200);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, token.instanceId));
    }).pipe(logLevel),
  options,
);
