import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeToken } from "./modelServing.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("modelserving", "token"), timeout: 300_000 } as const;

const app = (props: Stackit.ModelServing.TokenProps) =>
  Effect.gen(function* () {
    const token = yield* Stackit.ModelServing.Token("AppToken", props);
    return { token };
  });

const fetchToken = (projectId: string, region: string, tId: string) =>
  modelServing
    .getToken({ projectId, regionId: region, tId })
    .pipe(Effect.map(({ token }) => token));

test.provider(
  "create, update, rotate and delete a token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        description: "alchemy test token",
        labels: { env: "test" },
      } satisfies Stackit.ModelServing.TokenProps;
      const { token } = yield* stack.deploy(app(props));
      expect(token.tokenId).toEqual(expect.any(String));
      expect(Redacted.isRedacted(token.token)).toBe(true);
      expect(Redacted.value(token.token!).length).toBeGreaterThan(0);
      expect(token.adopted).toBe(false);
      expect(token.state).toEqual("active");
      expect(token.labels).toEqual({ env: "test" });

      // Out of band: the token exists, its labels are ours, and its value isn't returned.
      const fetched = yield* fetchToken(projectId, region, token.tokenId);
      expect(fetched.name).toEqual(token.name);
      expect(fetched.state).toEqual("active");
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "AppToken" });
      expect("content" in fetched).toBe(false);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.AppToken).toMatchObject({ action: "noop" });

      // Name, description and labels update in place and keep the value.
      const { token: updated } = yield* stack.deploy(
        app({
          name: "alchemy-model-token-updated",
          description: "alchemy test token updated",
          labels: { stage: "prod" },
        }),
      );
      expect(updated.tokenId).toEqual(token.tokenId);
      expect(updated.name).toEqual("alchemy-model-token-updated");
      expect(updated.description).toEqual("alchemy test token updated");
      expect(updated.labels).toEqual({ stage: "prod" });
      expect(Redacted.value(updated.token!)).toEqual(Redacted.value(token.token!));

      // Out of band: the removed label went, which only a `null` in the PATCH does.
      const refetched = yield* fetchToken(projectId, region, token.tokenId);
      expect(refetched.name).toEqual("alchemy-model-token-updated");
      expect(refetched.labels).toMatchObject({ stage: "prod", "alchemy.id": "AppToken" });
      expect(refetched.labels?.env).toBeUndefined();

      // Changing the rotation trigger makes a new token with a new value. The name is explicit,
      // so the old token goes first.
      const { token: rotated } = yield* stack.deploy(
        app({ name: "alchemy-model-token-updated", rotateWhenChanged: { rotation: "1" } }),
      );
      expect(rotated.tokenId).not.toEqual(token.tokenId);
      expect(Redacted.value(rotated.token!)).not.toEqual(Redacted.value(token.token!));
      yield* expectGone(observeToken(projectId, region, token.tokenId));

      yield* stack.destroy();
      yield* expectGone(observeToken(projectId, region, rotated.tokenId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a lifetime makes a token expire, and changing it replaces the token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { token } = yield* stack.deploy(app({ ttlDuration: "24h" }));
      const hoursLeft = (new Date(token.validUntil).getTime() - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(23);
      expect(hoursLeft).toBeLessThanOrEqual(24);

      const { token: replaced } = yield* stack.deploy(app({ ttlDuration: "48h" }));
      expect(replaced.tokenId).not.toEqual(token.tokenId);
      expect(new Date(replaced.validUntil).getTime()).toBeGreaterThan(
        new Date(token.validUntil).getTime(),
      );
      yield* expectGone(observeToken(projectId, region, token.tokenId));

      yield* stack.destroy();
      yield* expectGone(observeToken(projectId, region, replaced.tokenId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a foreign token with the explicit name is unowned",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      const name = "alchemy-model-token-foreign";
      const { token: foreign } = yield* modelServing.createToken({
        projectId,
        regionId: region,
        name,
      });

      const failure = yield* stack.deploy(app({ name })).pipe(Effect.flip);
      expect(failure._tag).toEqual("OwnedBySomeoneElse");

      // Refusing it left it alone.
      const still = yield* fetchToken(projectId, region, foreign.id);
      expect(still.name).toEqual(name);

      yield* modelServing.deleteToken({ projectId, regionId: region, tId: foreign.id });
      yield* expectGone(observeToken(projectId, region, foreign.id));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
