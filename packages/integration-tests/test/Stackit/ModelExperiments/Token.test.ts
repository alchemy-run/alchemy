import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  INSTANCE_TEST_TIMEOUT,
  observeInstance,
  observeToken,
  slow,
} from "./modelExperiments.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("modelexperiments", "token"),
  timeout: INSTANCE_TEST_TIMEOUT,
} as const;

const app = (props: Omit<Stackit.ModelExperiments.TokenProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.ModelExperiments.Instance("TokenExperiments", {});
    const token = yield* Stackit.ModelExperiments.Token("AppToken", {
      instanceId: instance.instanceId,
      ...props,
    });
    return { instance, token };
  });

test.provider.skipIf(slow)(
  "create, update, rotate and delete a token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        description: "alchemy test token",
        labels: { env: "test" },
      } satisfies Omit<Stackit.ModelExperiments.TokenProps, "instanceId">;
      const { instance, token } = yield* stack.deploy(app(props));
      const instanceId = instance.instanceId;
      expect(Redacted.isRedacted(token.token)).toBe(true);
      expect(Redacted.value(token.token!).length).toBeGreaterThan(0);
      expect(token.adopted).toBe(false);
      expect(token.state).toEqual("active");
      expect(token.instanceUrl).toEqual(instance.url);
      expect(token.labels).toEqual({ env: "test" });

      // Out of band: the token exists, its labels are ours, and its value isn't returned.
      const fetched = yield* modelExperiments.getInstanceToken({
        projectId,
        regionId: region,
        instanceId,
        tokenId: token.tokenId,
      });
      expect(fetched.token.state).toEqual("active");
      expect(fetched.token.labels).toMatchObject({ env: "test", "alchemy.id": "AppToken" });
      expect("content" in fetched.token).toBe(false);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.AppToken).toMatchObject({ action: "noop" });

      // Name, description and labels update in place and keep the value.
      const { token: updated } = yield* stack.deploy(
        app({
          name: "alchemy-tracking-updated",
          description: "alchemy test token updated",
          labels: { stage: "prod" },
        }),
      );
      expect(updated.tokenId).toEqual(token.tokenId);
      expect(updated.name).toEqual("alchemy-tracking-updated");
      expect(Redacted.value(updated.token!)).toEqual(Redacted.value(token.token!));
      const refetched = yield* modelExperiments.getInstanceToken({
        projectId,
        regionId: region,
        instanceId,
        tokenId: token.tokenId,
      });
      expect(refetched.token.labels).toMatchObject({ stage: "prod", "alchemy.id": "AppToken" });
      expect(refetched.token.labels?.env).toBeUndefined();

      // Changing the rotation trigger makes a new token with a new value. The name is explicit,
      // so the old token goes first.
      const { token: rotated } = yield* stack.deploy(
        app({ name: "alchemy-tracking-updated", rotateWhenChanged: { rotation: "1" } }),
      );
      expect(rotated.tokenId).not.toEqual(token.tokenId);
      expect(Redacted.value(rotated.token!)).not.toEqual(Redacted.value(token.token!));
      yield* expectGone(observeToken(projectId, region, instanceId, token.tokenId));

      // A lifetime is set at creation, so changing it replaces the token too.
      const { token: expiring } = yield* stack.deploy(
        app({ name: "alchemy-tracking-updated", ttlDuration: "24h" }),
      );
      expect(expiring.tokenId).not.toEqual(rotated.tokenId);
      const hoursLeft = (new Date(expiring.validUntil).getTime() - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(23);
      expect(hoursLeft).toBeLessThanOrEqual(24);

      yield* stack.destroy();
      yield* expectGone(observeToken(projectId, region, instanceId, expiring.tokenId));
      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);
