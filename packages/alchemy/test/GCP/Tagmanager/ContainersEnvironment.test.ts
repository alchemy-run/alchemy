import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteContainer, ensureParents } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (path: string) =>
  tagmanager.getAccountsContainersEnvironments({ path }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsContainersEnvironments on a missing environment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tagmanager.getAccountsContainersEnvironments({
          path: "accounts/0/containers/0/environments/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_TAGMANAGER,
)(
  "create, update, and delete a container environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureParents("alchemy-tm2-env", "web");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersEnvironment("Preview", {
            container: parent.containerPath,
            description: "QA preview",
            enableDebug: true,
          });
        }),
      );

      expect(created.path).toContain("/environments/");
      expect(created.container).toEqual(parent.containerPath);
      expect(created.description).toEqual("QA preview");
      expect(created.enableDebug).toEqual(true);

      const fetched = yield* tagmanager.getAccountsContainersEnvironments({
        path: created.path,
      });
      expect(fetched.path).toEqual(created.path);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.ContainersEnvironment("Preview", {
            container: parent.containerPath,
            environmentId: created.environmentId,
            description: "QA preview v2",
            enableDebug: false,
          });
        }),
      );

      expect(updated.path).toEqual(created.path);
      expect(updated.description).toEqual("QA preview v2");
      expect(updated.enableDebug).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.path);
      expect(gone).toEqual("gone");

      yield* deleteContainer(parent.containerPath);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
