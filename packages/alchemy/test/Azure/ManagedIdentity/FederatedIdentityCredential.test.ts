import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as msi from "@distilled.cloud/azure/msi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

const getCredential = (
  resourceGroupName: string,
  resourceName: string,
  federatedIdentityCredentialResourceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* msi.GetFederatedIdentityCredentials({
      subscriptionId,
      resourceGroupName,
      resourceName,
      federatedIdentityCredentialResourceName,
    });
  });

const credentialGone = (
  resourceGroupName: string,
  resourceName: string,
  credentialName: string,
) =>
  getCredential(resourceGroupName, resourceName, credentialName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (
  credentials: {
    id: string;
    name?: string;
    subject: string;
    audiences?: string[];
  }[],
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const creds = yield* Effect.all(
      credentials.map((c) =>
        Azure.ManagedIdentity.FederatedIdentityCredential(c.id, {
          resourceGroup: group.resourceGroupName,
          identity: identity.identityName,
          name: c.name,
          issuer: GITHUB_ISSUER,
          subject: c.subject,
          audiences: c.audiences,
        }),
      ),
      { concurrency: "unbounded" },
    );
    return { group, identity, creds };
  });

test.provider(
  "create, update, replace, and delete a federated identity credential",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Two credentials on one identity deployed in parallel exercise the
      // concurrent-write retry.
      const created = yield* stack.deploy(
        program([
          {
            id: "Main",
            subject: "repo:alchemy-run/alchemy:ref:refs/heads/main",
          },
          { id: "Pr", subject: "repo:alchemy-run/alchemy:pull_request" },
        ]),
      );
      const rg = created.group.resourceGroupName;
      const idName = created.identity.identityName;
      const [main, pr] = created.creds;
      expect(main!.issuer).toEqual(GITHUB_ISSUER);
      expect(main!.audiences).toEqual(["api://AzureADTokenExchange"]);
      expect(main!.credentialId).toContain("/federatedIdentityCredentials/");
      const observed = yield* getCredential(rg, idName, main!.credentialName);
      expect(observed.properties?.subject).toEqual(
        "repo:alchemy-run/alchemy:ref:refs/heads/main",
      );
      const observedPr = yield* getCredential(rg, idName, pr!.credentialName);
      expect(observedPr.properties?.subject).toEqual(
        "repo:alchemy-run/alchemy:pull_request",
      );

      // In-place update of subject and audiences; drop the second one.
      const updated = yield* stack.deploy(
        program([
          {
            id: "Main",
            subject: "repo:alchemy-run/alchemy:environment:prod",
            audiences: ["api://AzureADTokenExchangeCustom"],
          },
        ]),
      );
      expect(updated.creds[0]!.credentialName).toEqual(main!.credentialName);
      const reobserved = yield* getCredential(rg, idName, main!.credentialName);
      expect(reobserved.properties?.subject).toEqual(
        "repo:alchemy-run/alchemy:environment:prod",
      );
      expect(reobserved.properties?.audiences).toEqual([
        "api://AzureADTokenExchangeCustom",
      ]);
      expect(yield* credentialGone(rg, idName, pr!.credentialName)).toEqual(
        "gone",
      );

      // Renaming replaces the credential.
      const renamed = yield* stack.deploy(
        program([
          {
            id: "Main",
            name: "alchemy-renamed-fic",
            subject: "repo:alchemy-run/alchemy:environment:prod",
          },
        ]),
      );
      expect(renamed.creds[0]!.credentialName).toEqual("alchemy-renamed-fic");
      const replacement = yield* getCredential(
        rg,
        idName,
        "alchemy-renamed-fic",
      );
      expect(replacement.properties?.audiences).toEqual([
        "api://AzureADTokenExchange",
      ]);
      expect(yield* credentialGone(rg, idName, main!.credentialName)).toEqual(
        "gone",
      );

      // Removing it from the stack deletes it.
      yield* stack.deploy(program([]));
      expect(yield* credentialGone(rg, idName, "alchemy-renamed-fic")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:managedidentity", "live"],
    timeout: 600_000,
  },
);
