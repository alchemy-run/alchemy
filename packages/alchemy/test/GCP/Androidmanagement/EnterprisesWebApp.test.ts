import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  enterpriseName,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  androidmanagement.getEnterprisesWebApps({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getEnterprisesWebApps on a missing web app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.getEnterprisesWebApps({
          name: "enterprises/alchemy-missing-enterprise/webApps/com.alchemy.missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANDROIDMANAGEMENT)(
  "createEnterprisesWebApps without Android Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.createEnterprisesWebApps({
          parent: "enterprises/alchemy-missing-enterprise",
          body: {
            title: "Alchemy Probe",
            startUrl: "https://example.com/",
            displayMode: "STANDALONE",
          },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a web app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.Androidmanagement.Enterprise("WebHost", {
                enterpriseDisplayName: "Web Host",
              });
          const app = yield* GCP.Androidmanagement.EnterprisesWebApp("Docs", {
            parent: enterprise.name,
            startUrl: "https://example.com/alchemy-docs",
            title: "Docs",
          });
          return { enterprise, app };
        }),
      );

      expect(created.app.name).toContain("/webApps/");
      expect(created.app.parent).toEqual(created.enterprise.name);
      expect(created.app.title).toEqual("Docs");
      expect(created.app.startUrl).toEqual("https://example.com/alchemy-docs");

      const fetched = yield* androidmanagement.getEnterprisesWebApps({
        name: created.app.name,
      });
      expect(fetched.name).toEqual(created.app.name);
      expect(fetched.title).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.Androidmanagement.Enterprise("WebHost", {
                enterpriseDisplayName: "Web Host",
              });
          return yield* GCP.Androidmanagement.EnterprisesWebApp("Docs", {
            parent: enterprise.name,
            startUrl:
              created.app.startUrl ?? "https://example.com/alchemy-docs",
            title: "Internal docs",
            displayMode: "MINIMAL_UI",
          });
        }),
      );

      expect(updated.name).toEqual(created.app.name);
      expect(updated.title).toEqual("Internal docs");
      expect(updated.displayMode).toEqual("MINIMAL_UI");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.app.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
