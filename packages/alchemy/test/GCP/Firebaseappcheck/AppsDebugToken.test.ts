import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  APP_CHECK_DISABLED,
  FIREBASE_DISABLED,
  hasGcpCreds,
  logLevel,
  missingDebugToken,
  probeAppCheck,
  probeTags,
  resolveAppId,
  waitUntilDebugTokenGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsAppsDebugTokens on a missing token fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseappcheck.getProjectsAppsDebugTokens({
          name: missingDebugToken(),
        }),
      );
      expect(probeTags).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(APP_CHECK_DISABLED);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a debug token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAppCheck();
      if (access !== "enabled") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(APP_CHECK_DISABLED);
        yield* stack.destroy();
        return;
      }

      const app = yield* resolveAppId();
      if (typeof app !== "string") {
        expect(app._tag).toEqual("Forbidden");
        expect(app.message).toContain(FIREBASE_DISABLED);
        yield* stack.destroy();
        return;
      }
      expect(app).not.toEqual("missing");
      if (app === "missing") {
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaseappcheck.AppsDebugToken("Local", {
            app,
            displayName: "alchemy-test",
          });
        }),
      );

      expect(created.name).toContain("/debugTokens/");
      expect(created.debugTokenId).toEqual(expect.any(String));
      expect(created.appId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy-test");
      expect(created.token).toEqual(expect.any(String));
      expect((created.token ?? "").length).toBeGreaterThan(8);

      const fetched = yield* firebaseappcheck.getProjectsAppsDebugTokens({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("alchemy-test");
      expect(fetched.token).toBeFalsy();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaseappcheck.AppsDebugToken("Local", {
            app,
            displayName: "alchemy-prod",
            token: created.token,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod");
      expect(updated.token).toEqual(created.token);

      yield* stack.destroy();

      const gone = yield* waitUntilDebugTokenGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
