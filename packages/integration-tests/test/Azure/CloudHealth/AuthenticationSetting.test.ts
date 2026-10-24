import * as Azure from "@alchemy.run/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, modelProgram, modelWhere, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (rg: string, model: string, authenticationSettingName: string) =>
  Effect.flatMap(modelWhere(rg, model), (where) =>
    cloudhealth.GetAuthenticationSettings({ ...where, authenticationSettingName }),
  );

const program = (props: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const { group, model } = yield* modelProgram;
    const auth = yield* Azure.CloudHealth.AuthenticationSetting("Auth", {
      resourceGroup: group.resourceGroupName,
      healthModel: model.healthModelName,
      name: props.name,
      displayName: props.displayName,
    });
    return { group, model, auth };
  });

// An empty health model is free; a few minutes per run.
test.provider(
  "create, update, replace, and delete a health model authentication setting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model, auth } = yield* stack.deploy(
        program({ name: "auth-a", displayName: "v1" }),
      );
      const rg = group.resourceGroupName;
      const hm = model.healthModelName;
      expect(auth.authenticationSettingName).toEqual("auth-a");
      expect(auth.authenticationKind).toEqual("ManagedIdentity");
      expect(auth.managedIdentityName).toEqual("SystemAssigned");
      const observed = yield* getSetting(rg, hm, "auth-a");
      expect(observed.properties?.displayName).toEqual("v1");
      expect(observed.properties?.managedIdentityName).toEqual("SystemAssigned");

      // In place: display name.
      const updated = yield* stack.deploy(program({ name: "auth-a", displayName: "v2" }));
      expect(updated.auth.authenticationSettingId).toEqual(auth.authenticationSettingId);
      const reobserved = yield* getSetting(rg, hm, "auth-a");
      expect(reobserved.properties?.displayName).toEqual("v2");

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(program({ name: "auth-b", displayName: "v2" }));
      expect(replaced.auth.authenticationSettingName).toEqual("auth-b");
      const fresh = yield* getSetting(rg, hm, "auth-b");
      expect(fresh.properties?.displayName).toEqual("v2");
      const replacedOld = yield* gone(getSetting(rg, hm, "auth-a"));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getSetting(rg, hm, "auth-b"));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
