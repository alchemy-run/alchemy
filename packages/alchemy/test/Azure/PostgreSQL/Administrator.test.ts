import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (withAdmin: boolean) =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer({
      authConfig: { activeDirectoryAuth: "Enabled", passwordAuth: "Enabled" },
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const admin = withAdmin
      ? yield* Azure.PostgreSQL.Administrator("ApiAdmin", {
          resourceGroup: group.resourceGroupName,
          server: server.serverName,
          objectId: identity.principalId,
          principalType: "ServicePrincipal",
          principalName: identity.identityName,
        })
      : undefined;
    return { group, server, identity, admin };
  });

/** The server's administrators (the single-administrator GET is unreliable). */
const listAdmins = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    const page =
      yield* postgresql.ListAdministratorsMicrosoftEntraByServer(ref);
    return page.value;
  });

// One Burstable B1ms server (≈ $0.02/h) for ~10 minutes.
test.provider(
  "make a managed identity an Entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program(true));
      const { group, server, identity } = deployed;
      const admin = deployed.admin!;
      expect(admin.objectId).toEqual(identity.principalId);
      expect(admin.principalType).toEqual("ServicePrincipal");
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      expect(admin.tenantId).toEqual(tenantId);
      const observed = (yield* listAdmins(
        group.resourceGroupName,
        server.serverName,
      )).find((a) => a.properties.objectId === identity.principalId);
      // PostgreSQL truncates role names to 63 characters.
      expect(observed?.properties.principalName).toEqual(
        identity.identityName.slice(0, 63),
      );
      expect(observed?.properties.principalType).toEqual("ServicePrincipal");

      // Redeploying the same administrator is a no-op that keeps it.
      const again = yield* stack.deploy(program(true));
      expect(again.admin?.administratorId).toEqual(admin.administratorId);

      // Removing the administrator alone deletes it from the server.
      yield* stack.deploy(program(false));
      const remaining = yield* listAdmins(
        group.resourceGroupName,
        server.serverName,
      );
      expect(
        remaining.some((a) => a.properties.objectId === identity.principalId),
      ).toEqual(false);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.gen(function* () {
            const ref = yield* serverRef(
              group.resourceGroupName,
              server.serverName,
            );
            return yield* postgresql.GetServer(ref);
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
