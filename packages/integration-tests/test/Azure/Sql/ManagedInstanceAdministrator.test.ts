import * as Azure from "@alchemy.run/azure";
import * as sql from "@distilled.cloud/azure/sql";
import * as roleManagement from "@distilled.cloud/microsoft-graph/roleManagement";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";
import { managedInstance } from "./managed.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Built-in Entra "Directory Readers" role template. */
const DIRECTORY_READERS = "88d8e3e3-8f55-4a1e-953a-9b9898b8876b";

/**
 * Azure resolves the administrator through the instance's identity, which
 * must hold the Entra "Directory Readers" role (otherwise the write fails
 * asynchronously with `ServicePrincipalLookupInAadFailed`). The test
 * principal is a directory administrator, so grant it via Microsoft Graph.
 * The assignment goes away with the instance's identity.
 */
const grantDirectoryReaders = (principalId: string) =>
  Effect.gen(function* () {
    const existing = yield* roleManagement.listRoleAssignments({
      filter: `principalId eq '${principalId}' and roleDefinitionId eq '${DIRECTORY_READERS}'`,
    });
    if (existing.value.length === 0) {
      const created = yield* roleManagement.createRoleAssignments({
        principalId,
        roleDefinitionId: DIRECTORY_READERS,
        directoryScopeId: "/",
      });
      expect(created.principalId).toEqual(principalId);
      yield* Effect.logInfo(`granted Directory Readers to ${principalId}: ${created.id}`);
    }
  });

const getSetting = (resourceGroupName: string, managedInstanceName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedInstanceAdministrator({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      administratorName: "ActiveDirectory",
    });
  });

type Step = "First" | "Second" | undefined;

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password, {
      identity: { type: "SystemAssigned" },
    });
    // Short names: the instance rejects the generated ~128 character
    // identity names as logins (`ManagedInstanceHasNoPermissionsToAccessAad`
    // "The requested principal is not a valid login ...").
    const first = yield* Azure.ManagedIdentity.UserAssignedIdentity("First", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      name: "alchemy-mi-admin-first",
    });
    const second = yield* Azure.ManagedIdentity.UserAssignedIdentity("Second", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      name: "alchemy-mi-admin-second",
    });
    const chosen = step === "Second" ? second : first;
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceAdministrator("Setting", {
            resourceGroup: group.resourceGroupName,
            managedInstance: instance.managedInstanceName,
            login: chosen.identityName,
            sid: chosen.clientId,
          });
    return { group, instance, first, second, setting };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "set, update, and remove a managed instance entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      // The instance first, so its identity can be granted Directory Readers.
      const base = yield* stack.deploy(program(password, undefined));
      const principalId = base.instance.principalId ?? "";
      expect(principalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      yield* grantDirectoryReaders(principalId);

      // The role grant takes a while to reach the instance's lookups.
      const first = yield* stack.deploy(program(password, "First")).pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningTimedOut",
          schedule: Schedule.spaced("1 minute"),
          times: 5,
        }),
      );
      const { group, instance } = first;
      const get = getSetting(group.resourceGroupName, instance.managedInstanceName);

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.login === first.first.identityName,
        12,
      );
      expect(observed1.properties?.sid?.toLowerCase()).toEqual(first.first.clientId.toLowerCase());

      // In place update.
      const second = yield* stack.deploy(program(password, "Second"));
      expect(second.setting?.administratorId).toEqual(first.setting?.administratorId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.login === second.second.identityName,
        12,
      );
      expect(observed2.properties?.sid?.toLowerCase()).toEqual(
        second.second.clientId.toLowerCase(),
      );

      // Removing the resource removes the administrator.
      yield* stack.deploy(program(password, undefined));
      expect(yield* awaitGone(get)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
