import * as Azure from "@alchemy.run/azure";
import { requestClientSecretToken } from "@distilled.cloud/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { applicationGone, eventually, getApplication } from "./graph.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const program = (endDateTime: string) =>
  Effect.gen(function* () {
    const app = yield* Azure.Entra.Application("App");
    // Entra issues tokens only to an application with a service principal.
    const principal = yield* Azure.Entra.ServicePrincipal("Principal", { appId: app.appId });
    const password = yield* Azure.Entra.ApplicationPassword("Secret", {
      applicationObjectId: app.objectId,
      displayName: "alchemy-test",
      endDateTime,
    });
    return { app, principal, password };
  });

const keyIds = (objectId: string) =>
  getApplication(objectId).pipe(
    Effect.map((app) => (app.passwordCredentials ?? []).map((credential) => credential.keyId)),
  );

/** Sign in with the secret; a new secret takes a little while to work. */
const signIn = (tenantId: string, clientId: string, secret: Redacted.Redacted<string>) =>
  requestClientSecretToken(
    { tenantId, clientId, clientSecret: secret, subscriptionId: "" },
    "https://management.azure.com/.default",
  ).pipe(
    Effect.retry({
      while: (e) => e._tag === "InvalidClientSecret",
      schedule: Schedule.spaced("5 seconds"),
      times: 18,
    }),
  );

// Entra applications and their secrets are free.
test.provider(
  "create, rotate, and delete an Entra application password",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app, password } = yield* stack.deploy(program("2027-06-30T00:00:00Z"));
      expect(password.applicationObjectId).toEqual(app.objectId);
      expect(password.displayName).toEqual("alchemy-test");
      expect(password.endDateTime?.startsWith("2027-06-30T00:00:00")).toEqual(true);
      expect(Redacted.isRedacted(password.secretText)).toEqual(true);
      expect(Redacted.value(password.secretText).slice(0, 3)).toEqual(password.hint);
      expect(
        yield* eventually(keyIds(app.objectId), (ids) => ids.includes(password.keyId)),
      ).toEqual([password.keyId]);

      const token = yield* signIn(app.tenantId, app.appId, password.secretText);
      expect(Redacted.value(token.token).split(".").length).toEqual(3);

      // A new expiry rotates the secret: new key in, old key out.
      const { password: rotated } = yield* stack.deploy(program("2027-12-31T00:00:00Z"));
      expect(rotated.keyId).not.toEqual(password.keyId);
      expect(Redacted.value(rotated.secretText)).not.toEqual(Redacted.value(password.secretText));
      expect(
        yield* eventually(
          keyIds(app.objectId),
          (ids) => ids.includes(rotated.keyId) && !ids.includes(password.keyId),
        ),
      ).toEqual([rotated.keyId]);

      yield* stack.destroy();
      expect(yield* applicationGone(app.objectId)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:azure", "provider:azure:entra", "live"], timeout: 420_000 },
);
