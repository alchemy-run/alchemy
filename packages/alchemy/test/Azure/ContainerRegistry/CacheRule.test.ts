import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCacheRule = (
  resourceGroupName: string,
  registryName: string,
  cacheRuleName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetCacheRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      cacheRuleName,
    });
  });

const program = (props: { target: string; withCredentials: boolean }) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    // The credential set stays deployed across every step.
    const credentials = yield* Azure.ContainerRegistry.CredentialSet(
      "Upstream",
      {
        resourceGroup: group.resourceGroupName,
        registry: registry.registryName,
        loginServer: "docker.io",
        usernameSecretIdentifier:
          "https://alchemy-test.vault.azure.net/secrets/hub-user",
        passwordSecretIdentifier:
          "https://alchemy-test.vault.azure.net/secrets/hub-token",
      },
    );
    const rule = yield* Azure.ContainerRegistry.CacheRule("Cache", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      sourceRepository: "mcr.microsoft.com/hello-world",
      targetRepository: props.target,
      credentialSetResourceId: props.withCredentials
        ? credentials.credentialSetId
        : undefined,
    });
    return { group, registry, credentials, rule };
  });

// Basic registry (~$0.17/day): well under $1, about a minute.
test.provider(
  "create, update, replace, and delete a cache rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, credentials, rule } = yield* stack.deploy(
        program({ target: "hello-world", withCredentials: false }),
      );
      const get = (name: string) =>
        getCacheRule(group.resourceGroupName, registry.registryName, name);
      expect(rule.targetRepository).toEqual("hello-world");
      const observed = yield* get(rule.cacheRuleName);
      expect(observed.properties?.sourceRepository).toEqual(
        "mcr.microsoft.com/hello-world",
      );
      expect(observed.properties?.targetRepository).toEqual("hello-world");
      expect(observed.properties?.credentialSetResourceId || undefined).toBe(
        undefined,
      );

      // In-place: attach the credential set.
      const updated = yield* stack.deploy(
        program({ target: "hello-world", withCredentials: true }),
      );
      expect(updated.rule.cacheRuleId).toEqual(rule.cacheRuleId);
      const reobserved = yield* get(rule.cacheRuleName);
      expect(
        reobserved.properties?.credentialSetResourceId?.toLowerCase(),
      ).toEqual(credentials.credentialSetId.toLowerCase());

      // Replacement: the target repository is immutable.
      const replaced = yield* stack.deploy(
        program({ target: "hello-world-2", withCredentials: true }),
      );
      expect(replaced.rule.cacheRuleName).not.toEqual(rule.cacheRuleName);
      const replacedObserved = yield* get(replaced.rule.cacheRuleName);
      expect(replacedObserved.properties?.targetRepository).toEqual(
        "hello-world-2",
      );
      expect(yield* waitGone(get(rule.cacheRuleName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
