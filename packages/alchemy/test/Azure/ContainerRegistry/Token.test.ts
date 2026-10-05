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

const getToken = (
  resourceGroupName: string,
  registryName: string,
  tokenName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetToken({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      tokenName,
    });
  });

const program = (props: {
  scope: "Pull" | "Push";
  name?: string;
  status: "enabled" | "disabled";
  passwords: Azure.ContainerRegistry.TokenPasswordSpec[];
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    // Both scope maps stay deployed across every step.
    const pull = yield* Azure.ContainerRegistry.ScopeMap("Pull", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      actions: ["repositories/app/content/read"],
    });
    const push = yield* Azure.ContainerRegistry.ScopeMap("Push", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      actions: [
        "repositories/app/content/read",
        "repositories/app/content/write",
      ],
    });
    const token = yield* Azure.ContainerRegistry.Token("Token", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: props.name,
      scopeMapId: props.scope === "Pull" ? pull.scopeMapId : push.scopeMapId,
      status: props.status,
      passwords: props.passwords,
    });
    return { group, registry, pull, push, token };
  });

// Basic registry (~$0.17/day): well under $1, about two minutes.
test.provider(
  "create, update, replace, and delete a token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, pull, push, token } = yield* stack.deploy(
        program({
          scope: "Pull",
          status: "enabled",
          passwords: [{ name: "password1" }],
        }),
      );
      const get = (name: string) =>
        getToken(group.resourceGroupName, registry.registryName, name);
      expect(token.scopeMapId.toLowerCase()).toEqual(
        pull.scopeMapId.toLowerCase(),
      );
      expect(token.passwords.map((p) => p.name)).toEqual(["password1"]);
      const password1 = token.passwords[0]!.value;
      expect(password1).toBeDefined();
      expect(Redacted.value(password1!).length).toBeGreaterThan(10);
      const observed = yield* get(token.tokenName);
      expect(observed.properties?.status).toEqual("enabled");
      expect(
        observed.properties?.credentials?.passwords?.map((p) => p.name),
      ).toEqual(["password1"]);

      // A no-op redeploy keeps the generated password.
      const again = yield* stack.deploy(
        program({
          scope: "Pull",
          status: "enabled",
          passwords: [{ name: "password1" }],
        }),
      );
      expect(Redacted.value(again.token.passwords[0]!.value!)).toEqual(
        Redacted.value(password1!),
      );

      // In-place: switch scope map, disable, rotate to password2.
      const updated = yield* stack.deploy(
        program({
          scope: "Push",
          status: "disabled",
          passwords: [{ name: "password2" }],
        }),
      );
      expect(updated.token.tokenId).toEqual(token.tokenId);
      expect(updated.token.passwords.map((p) => p.name)).toEqual(["password2"]);
      expect(updated.token.passwords[0]!.value).toBeDefined();
      const reobserved = yield* get(token.tokenName);
      expect(reobserved.properties?.status).toEqual("disabled");
      expect(reobserved.properties?.scopeMapId?.toLowerCase()).toEqual(
        push.scopeMapId.toLowerCase(),
      );
      expect(
        reobserved.properties?.credentials?.passwords?.map((p) => p.name),
      ).toEqual(["password2"]);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          scope: "Push",
          name: "alchemytokentest",
          status: "disabled",
          passwords: [],
        }),
      );
      expect(replaced.token.tokenName).toEqual("alchemytokentest");
      yield* get("alchemytokentest");
      expect(yield* waitGone(get(token.tokenName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
