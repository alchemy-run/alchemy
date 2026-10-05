import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  flexApp,
  flexConnectionString,
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAuth = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppAuthSettingsV2({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const appGone = (resourceGroupName: string, name: string) =>
  getAuth(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/** Poll the app until it answers with `status` (auth changes roll out async). */
const expectStatus = (url: string, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.map((res) => res.status),
      Effect.catch(() => Effect.succeed(0)),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (observed) => observed === status,
        times: 36,
      }),
    );
  });

const program = (
  connection: string,
  auth: "Return401" | "Return403" | undefined,
) =>
  Effect.gen(function* () {
    const { group, app } = yield* flexApp(connection);
    if (auth !== undefined) {
      yield* Azure.Web.WebAppAuthSettings("Auth", {
        resourceGroup: group.resourceGroupName,
        siteName: app.siteName,
        globalValidation: {
          requireAuthentication: true,
          unauthenticatedClientAction: auth,
        },
      });
    }
    return { group, app };
  });

// Cost: ~$0 (Flex Consumption, idle; Standard_LRS storage). Provisioning:
// ~2-4 minutes.
test.provider(
  "enable, update, and disable App Service Authentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      // Create: anonymous requests are rejected with 401.
      const { app } = yield* stack.deploy(program(connection, "Return401"));
      const observed = yield* getAuth(group.resourceGroupName, app.siteName);
      expect(observed.properties?.platform?.enabled).toEqual(true);
      expect(
        observed.properties?.globalValidation?.unauthenticatedClientAction,
      ).toEqual("Return401");
      expect(yield* expectStatus(app.url, 401)).toEqual(401);

      // In-place update: 401 -> 403.
      yield* stack.deploy(program(connection, "Return403"));
      const updated = yield* getAuth(group.resourceGroupName, app.siteName);
      expect(
        updated.properties?.globalValidation?.unauthenticatedClientAction,
      ).toEqual("Return403");
      expect(yield* expectStatus(app.url, 403)).toEqual(403);

      // Delete: removing the resource disables authentication again.
      yield* stack.deploy(program(connection, undefined));
      const disabled = yield* getAuth(group.resourceGroupName, app.siteName);
      expect(disabled.properties?.platform?.enabled ?? false).toEqual(false);

      yield* stack.destroy();
      expect(yield* appGone(group.resourceGroupName, app.siteName)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
