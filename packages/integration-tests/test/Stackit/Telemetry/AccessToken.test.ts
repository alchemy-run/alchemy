import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeAccessToken, observeRouter } from "./telemetry.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("telemetry", "accesstoken"), timeout: 900_000 } as const;

/** The router, plus the token when `token` is given. */
const app = (token?: Omit<Stackit.Telemetry.AccessTokenProps, "routerId">) =>
  Effect.gen(function* () {
    const parent = yield* Stackit.Telemetry.Router("TokenRouter", {});
    if (token === undefined) return { router: parent, token: undefined };
    return {
      router: parent,
      token: yield* Stackit.Telemetry.AccessToken("TokenUnderTest", {
        routerId: parent.routerId,
        ...token,
      }),
    };
  });

test.provider(
  "create, update, rotate and delete an access token",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { description: "alchemy test token", ttlDays: 30 };
      const created = yield* stack.deploy(app(props));
      const token = created.token!;
      const routerId = created.router.routerId;
      // The API only returns the value on create, and a token is a JWT.
      expect(Redacted.value(token.accessToken!).split(".")).toHaveLength(3);
      expect(token.status).toEqual("active");
      expect(token.expirationTime).toEqual(expect.any(String));

      // Out of band.
      const fetched = yield* router.getAccessToken({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        accessTokenId: token.accessTokenId,
      });
      expect(fetched.description).toEqual("alchemy test token");

      // Redeploying unchanged is a no-op, and keeps the value.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.TokenUnderTest).toMatchObject({ action: "noop" });

      // The description updates in place and keeps the value.
      const updated = yield* stack.deploy(app({ ...props, description: "alchemy test updated" }));
      expect(updated.token!.accessTokenId).toEqual(token.accessTokenId);
      expect(Redacted.value(updated.token!.accessToken!)).toEqual(
        Redacted.value(token.accessToken!),
      );
      const afterUpdate = yield* router.getAccessToken({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        accessTokenId: token.accessTokenId,
      });
      expect(afterUpdate.description).toEqual("alchemy test updated");

      // A new rotation key is a new token, and the old one is gone.
      const rotated = yield* stack.deploy(
        app({ ...props, description: "alchemy test updated", rotationKey: "2" }),
      );
      expect(rotated.token!.accessTokenId).not.toEqual(token.accessTokenId);
      expect(Redacted.value(rotated.token!.accessToken!)).not.toEqual(
        Redacted.value(token.accessToken!),
      );
      yield* expectGone(observeAccessToken(projectId, region, routerId, token.accessTokenId));

      // So is a new time to live.
      const longer = yield* stack.deploy(
        app({ description: "alchemy test updated", rotationKey: "2", ttlDays: 60 }),
      );
      expect(longer.token!.accessTokenId).not.toEqual(rotated.token!.accessTokenId);
      yield* expectGone(
        observeAccessToken(projectId, region, routerId, rotated.token!.accessTokenId),
      );

      yield* stack.destroy();
      yield* expectGone(
        observeAccessToken(projectId, region, routerId, longer.token!.accessTokenId),
      );
      yield* expectGone(observeRouter(projectId, region, routerId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a token of the same name without state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      const displayName = "alchemy-test-foreign";

      const parent = yield* stack.deploy(app());
      const telemetryRouterId = parent.router.routerId;
      const foreign = yield* router.createAccessToken({
        projectId,
        regionId: region,
        telemetryRouterId,
        displayName,
      });
      const error = yield* stack.deploy(app({ displayName })).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // It is still there: the refusal touched nothing.
      const after = yield* observeAccessToken(projectId, region, telemetryRouterId, foreign.id);
      expect(after).not.toEqual("gone");

      yield* router.deleteAccessToken({
        projectId,
        regionId: region,
        telemetryRouterId,
        accessTokenId: foreign.id,
      });
      yield* expectGone(observeAccessToken(projectId, region, telemetryRouterId, foreign.id));
      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, region, telemetryRouterId));
    }).pipe(logLevel),
  options,
);
