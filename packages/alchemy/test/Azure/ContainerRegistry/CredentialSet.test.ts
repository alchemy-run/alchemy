import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCredentialSet = (
  resourceGroupName: string,
  registryName: string,
  credentialSetName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetCredentialSet({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      credentialSetName,
    });
  });

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value !== undefined && Redacted.isRedacted(value)
    ? Redacted.value(value)
    : value;

// The secrets need not exist: ACR stores the references and reports the
// credential as unhealthy until its identity can read them.
const vault = "https://alchemy-test.vault.azure.net/secrets";

const program = (props: { loginServer: string; password: string }) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    const credentials = yield* Azure.ContainerRegistry.CredentialSet(
      "Upstream",
      {
        resourceGroup: group.resourceGroupName,
        registry: registry.registryName,
        loginServer: props.loginServer,
        usernameSecretIdentifier: `${vault}/hub-user`,
        passwordSecretIdentifier: `${vault}/${props.password}`,
      },
    );
    return { group, registry, credentials };
  });

// Basic registry (~$0.17/day): well under $1, about a minute.
test.provider(
  "create, update, replace, and delete a credential set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, credentials } = yield* stack.deploy(
        program({ loginServer: "docker.io", password: "hub-token" }),
      );
      const get = (name: string) =>
        getCredentialSet(group.resourceGroupName, registry.registryName, name);
      expect(credentials.principalId).toBeDefined();
      const observed = yield* get(credentials.credentialSetName);
      expect(observed.properties?.loginServer).toEqual("docker.io");
      expect(observed.identity?.type?.toLowerCase()).toEqual("systemassigned");
      const credential = observed.properties?.authCredentials?.[0];
      expect(credential?.usernameSecretIdentifier).toEqual(`${vault}/hub-user`);
      expect(reveal(credential?.passwordSecretIdentifier)).toEqual(
        `${vault}/hub-token`,
      );

      // In-place: point at a different password secret.
      const updated = yield* stack.deploy(
        program({ loginServer: "docker.io", password: "hub-token-2" }),
      );
      expect(updated.credentials.credentialSetId).toEqual(
        credentials.credentialSetId,
      );
      const reobserved = yield* get(credentials.credentialSetName);
      expect(
        reveal(
          reobserved.properties?.authCredentials?.[0]?.passwordSecretIdentifier,
        ),
      ).toEqual(`${vault}/hub-token-2`);

      // Replacement: the login server is immutable.
      const replaced = yield* stack.deploy(
        program({ loginServer: "ghcr.io", password: "hub-token-2" }),
      );
      expect(replaced.credentials.credentialSetName).not.toEqual(
        credentials.credentialSetName,
      );
      const replacedObserved = yield* get(
        replaced.credentials.credentialSetName,
      );
      expect(replacedObserved.properties?.loginServer).toEqual("ghcr.io");
      expect(yield* waitGone(get(credentials.credentialSetName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
