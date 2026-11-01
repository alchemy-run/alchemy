import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as logs from "@distilled.cloud/stackit/logs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance, observeToken } from "./logs.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("logs", "accesstoken"), timeout: 900_000 } as const;

const app = (props: Omit<Stackit.Logs.AccessTokenProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Logs.Instance("TokenLogs", {
      retentionDays: 1,
      acl: [CLOSED_ACL],
    });
    const token = yield* Stackit.Logs.AccessToken("AppToken", {
      instanceId: instance.instanceId,
      ...props,
    });
    return { instance, token };
  });

test.provider(
  "create, update, replace and delete a token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        permissions: ["read", "write"],
        description: "alchemy test token",
        labels: { env: "test" },
      } satisfies Omit<Stackit.Logs.AccessTokenProps, "instanceId">;
      const { instance, token } = yield* stack.deploy(app(props));
      expect(token.accessTokenId).toEqual(expect.any(String));
      expect(Redacted.isRedacted(token.accessToken)).toBe(true);
      expect(Redacted.value(token.accessToken!).length).toBeGreaterThan(0);
      expect(token.adopted).toBe(false);
      expect(token.status).toEqual("active");
      expect(token.expires).toBe(false);
      expect([...token.permissions].sort()).toEqual(["read", "write"]);
      expect(token.labels).toEqual({ env: "test" });
      expect(token.datasourceUrl).toEqual(instance.datasourceUrl);

      // Out of band: the token exists, its labels are ours, and its value isn't returned.
      const fetched = yield* logs.getAccessToken({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        tId: token.accessTokenId,
      });
      expect(fetched.accessToken).toBeUndefined();
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "AppToken" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.AppToken).toMatchObject({ action: "noop" });

      // Name, description and labels update in place and keep the value.
      const { token: updated } = yield* stack.deploy(
        app({
          permissions: ["read", "write"],
          displayName: "alchemy-token-updated",
          description: "alchemy test token, updated",
          labels: { env: "prod" },
        }),
      );
      expect(updated.accessTokenId).toEqual(token.accessTokenId);
      expect(updated.displayName).toEqual("alchemy-token-updated");
      expect(updated.description).toEqual("alchemy test token, updated");
      expect(updated.labels).toEqual({ env: "prod" });
      expect(Redacted.value(updated.accessToken!)).toEqual(Redacted.value(token.accessToken!));

      const refetched = yield* logs.getAccessToken({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        tId: token.accessTokenId,
      });
      expect(refetched.displayName).toEqual("alchemy-token-updated");
      expect(refetched.labels).toMatchObject({ env: "prod", "alchemy.id": "AppToken" });

      // The API can't change permissions: a new token with a new value, the old one gone.
      const { token: replaced } = yield* stack.deploy(
        app({ permissions: ["write"], displayName: "alchemy-token-updated" }),
      );
      expect(replaced.accessTokenId).not.toEqual(token.accessTokenId);
      expect(replaced.permissions).toEqual(["write"]);
      expect(Redacted.value(replaced.accessToken!)).not.toEqual(Redacted.value(token.accessToken!));
      yield* expectGone(observeToken(projectId, region, instance.instanceId, token.accessTokenId));

      yield* stack.destroy();
      yield* expectGone(
        observeToken(projectId, region, instance.instanceId, replaced.accessTokenId),
      );
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a lifetime makes a token expire, and changing it replaces the token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, token } = yield* stack.deploy(app({ permissions: ["read"], lifetime: 1 }));
      expect(token.expires).toBe(true);
      expect(new Date(token.validUntil!).getTime()).toBeGreaterThan(0);
      expect(token.lifetime).toEqual(1);

      const plan = yield* stack.plan(app({ permissions: ["read"], lifetime: 1 }));
      expect(plan.resources.AppToken).toMatchObject({ action: "noop" });

      const { token: replaced } = yield* stack.deploy(app({ permissions: ["read"], lifetime: 2 }));
      expect(replaced.accessTokenId).not.toEqual(token.accessTokenId);
      expect(replaced.lifetime).toEqual(2);
      yield* expectGone(observeToken(projectId, region, instance.instanceId, token.accessTokenId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a token with the same name and no labels is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const instance = yield* stack.deploy(
        Stackit.Logs.Instance("TokenLogs", { retentionDays: 1, acl: [CLOSED_ACL] }),
      );
      const foreign = yield* logs.createAccessToken({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        displayName: "alchemy-token-foreign",
        permissions: ["read"],
      });
      const error = yield* stack
        .deploy(
          app({
            permissions: ["read"],
            displayName: "alchemy-token-foreign",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The foreign token is untouched.
      const still = yield* observeToken(projectId, region, instance.instanceId, foreign.id);
      expect(still).not.toEqual("gone");

      yield* logs.deleteAccessToken({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        tId: foreign.id,
      });
      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);
