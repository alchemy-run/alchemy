import * as Azure from "@alchemy.run/azure";
import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { clusterRef, existingCluster, logLevel, tags, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRole = (roleName: string) =>
  Effect.gen(function* () {
    const ref = yield* clusterRef(existingCluster!.resourceGroup, existingCluster!.cluster);
    return yield* postgresqlhsc.GetRole({ ...ref, roleName });
  });

const program = (props: { name: string; password?: string }) =>
  Azure.CosmosDBPostgreSQL.Role("App", {
    resourceGroup: existingCluster!.resourceGroup,
    cluster: existingCluster!.cluster,
    name: props.name,
    password: props.password === undefined ? undefined : Redacted.make(props.password),
  });

// New clusters cannot be provisioned (service retirement); runs against an
// existing cluster from AZURE_COSMOS_PG_CLUSTER. Roles are free.
test.provider.skipIf(existingCluster === undefined)(
  "create, rotate the password, replace, and delete a role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(program({ name: "alchemy_app" }));
      expect(role.roleName).toEqual("alchemy_app");
      expect(Redacted.value(role.password!)).toMatch(/^Aa1-[A-Za-z0-9_-]{32}$/);
      const observed = yield* getRole("alchemy_app");
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // The password is mutable in place.
      const rotated = yield* stack.deploy(
        program({ name: "alchemy_app", password: "Aa1-rotated-password-42" }),
      );
      expect(rotated.roleId).toEqual(role.roleId);
      expect(Redacted.value(rotated.password!)).toEqual("Aa1-rotated-password-42");

      // Renaming replaces the role.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy_app2", password: "Aa1-rotated-password-42" }),
      );
      expect(renamed.roleName).toEqual("alchemy_app2");
      expect(yield* untilGone(getRole("alchemy_app"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* untilGone(getRole("alchemy_app2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
