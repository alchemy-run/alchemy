import * as Azure from "@alchemy.run/azure";
import * as applications from "@distilled.cloud/microsoft-graph/applications";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { applicationGone, eventually } from "./graph.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ISSUER = "https://token.actions.githubusercontent.com";

const program = (props: { name: string; subject: string; description: string }) =>
  Effect.gen(function* () {
    const app = yield* Azure.Entra.Application("App");
    const credential = yield* Azure.Entra.FederatedIdentityCredential("GitHub", {
      applicationObjectId: app.objectId,
      name: props.name,
      issuer: ISSUER,
      subject: props.subject,
      description: props.description,
    });
    return { app, credential };
  });

const getCredential = (applicationObjectId: string, name: string) =>
  applications
    .getFederatedIdentityCredentials({
      applicationId: applicationObjectId,
      federatedIdentityCredentialId: name,
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "ResourceNotFound",
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
    );

const credentialGone = (applicationObjectId: string, name: string) =>
  applications
    .getFederatedIdentityCredentials({
      applicationId: applicationObjectId,
      federatedIdentityCredentialId: name,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (status) => status === "gone",
        times: 40,
      }),
    );

// Entra applications and federated credentials are free.
test.provider(
  "create, update, replace, and delete a federated identity credential",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app, credential } = yield* stack.deploy(
        program({
          name: "github-main",
          subject: "repo:alchemy-run/alchemy:ref:refs/heads/main",
          description: "main branch",
        }),
      );
      expect(credential.name).toEqual("github-main");
      expect(credential.applicationObjectId).toEqual(app.objectId);
      expect(credential.audiences).toEqual(["api://AzureADTokenExchange"]);
      const observed = yield* getCredential(app.objectId, "github-main");
      expect(observed.id).toEqual(credential.federatedIdentityCredentialId);
      expect(observed.issuer).toEqual(ISSUER);
      expect(observed.subject).toEqual("repo:alchemy-run/alchemy:ref:refs/heads/main");
      expect(observed.description).toEqual("main branch");

      // Subject and description update in place.
      const { credential: updated } = yield* stack.deploy(
        program({
          name: "github-main",
          subject: "repo:alchemy-run/alchemy:environment:production",
          description: "production environment",
        }),
      );
      expect(updated.federatedIdentityCredentialId).toEqual(
        credential.federatedIdentityCredentialId,
      );
      const reobserved = yield* eventually(
        getCredential(app.objectId, "github-main"),
        (c) => c.subject === "repo:alchemy-run/alchemy:environment:production",
      );
      expect(reobserved.description).toEqual("production environment");

      // A new name replaces the credential.
      const { credential: renamed } = yield* stack.deploy(
        program({
          name: "github-production",
          subject: "repo:alchemy-run/alchemy:environment:production",
          description: "production environment",
        }),
      );
      expect(renamed.name).toEqual("github-production");
      expect(renamed.federatedIdentityCredentialId).not.toEqual(
        credential.federatedIdentityCredentialId,
      );
      expect(yield* credentialGone(app.objectId, "github-main")).toEqual("gone");
      const observedRenamed = yield* getCredential(app.objectId, "github-production");
      expect(observedRenamed.subject).toEqual("repo:alchemy-run/alchemy:environment:production");

      yield* stack.destroy();
      expect(yield* applicationGone(app.objectId)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:azure", "provider:azure:entra", "live"], timeout: 420_000 },
);
