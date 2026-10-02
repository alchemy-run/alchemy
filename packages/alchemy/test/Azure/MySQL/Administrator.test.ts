import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mysql from "@distilled.cloud/azure/mysql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  MYSQL_TEST_LOCATION,
  serverRef,
  tags,
  untilGone,
} from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (login: string | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Db", {
      resourceGroup: group.resourceGroupName,
      location: MYSQL_TEST_LOCATION,
    });
    const server = yield* Azure.MySQL.FlexibleServer("Server", {
      resourceGroup: group.resourceGroupName,
      location: MYSQL_TEST_LOCATION,
      userAssignedIdentityIds: [identity.identityId],
    });
    const admin =
      login === undefined
        ? undefined
        : yield* Azure.MySQL.Administrator("Admin", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            login,
            sid: identity.principalId,
            identityResourceId: identity.identityId,
          });
    return { group, server, identity, admin };
  });

const getAdmin = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* mysql.GetAzureADAdministrator({
      ...ref,
      administratorName: "ActiveDirectory",
    });
  });

// One Burstable B1ms server (≈ $0.02/h) for ~10 minutes. The identity has
// no Microsoft Graph permissions; ARM accepts the administrator anyway, but
// Entra sign-in needs them granted.
test.provider(
  "set, update, and remove the Entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program("alchemy-admins"));
      const { group, server, identity } = deployed;
      const admin = deployed.admin!;
      expect(admin.login).toEqual("alchemy-admins");
      expect(admin.sid).toEqual(identity.principalId);
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      expect(admin.tenantId).toEqual(tenantId);
      const observed = yield* getAdmin(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.login).toEqual("alchemy-admins");
      expect(observed.properties?.identityResourceId?.toLowerCase()).toEqual(
        identity.identityId.toLowerCase(),
      );

      // The login is mutable in place.
      const updated = yield* stack.deploy(program("alchemy-dbas"));
      expect(updated.admin?.administratorId).toEqual(admin.administratorId);
      const reobserved = yield* getAdmin(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.login).toEqual("alchemy-dbas");

      // Removing the administrator alone deletes it from the server.
      yield* stack.deploy(program(undefined));
      expect(
        yield* untilGone(getAdmin(group.resourceGroupName, server.serverName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.gen(function* () {
            const ref = yield* serverRef(
              group.resourceGroupName,
              server.serverName,
            );
            return yield* mysql.GetServer(ref);
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
