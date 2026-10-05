import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { managedInstance } from "./managed.ts";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const hasDirectoryReaders = !!process.env.AZURE_TEST_SQL_MI_DIRECTORY_READERS;

const getSetting = (resourceGroupName: string, managedInstanceName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedInstanceAzureADOnlyAuthentication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      authenticationName: "Default",
    });
  });

type Step = { azureADOnlyAuthentication: boolean };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password, {
      identity: { type: "SystemAssigned" },
    });
    // Entra-only authentication needs an Entra administrator first.
    const admin = yield* Azure.Sql.ManagedInstanceAdministrator("Admin", {
      resourceGroup: group.resourceGroupName,
      managedInstance: instance.managedInstanceName,
      login: "alchemy-admins",
      sid: "00000000-0000-0000-0000-000000000001",
    });
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceAzureADOnlyAuthentication("Setting", {
            resourceGroup: group.resourceGroupName,
            managedInstance: admin.managedInstanceName,
            ...step,
          });
    return { group, instance, setting };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1. The Entra administrator it depends on also
// needs the instance identity to hold the Entra "Directory Readers" role
// (otherwise the admin create fails asynchronously with
// `ServicePrincipalLookupInAadFailed`), so it only runs when
// AZURE_TEST_SQL_MI_DIRECTORY_READERS=1 (a tenant where new managed instance
// identities are granted Directory Readers, e.g. via a group).
test.provider.skipIf(!runExpensive || !hasDirectoryReaders)(
  "set, update, and reset managed instance entra-only authentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { azureADOnlyAuthentication: false }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.azureADOnlyAuthentication === false,
        12,
      );
      expect(observed1.properties?.azureADOnlyAuthentication).toEqual(false);

      // In place update.
      const second = yield* stack.deploy(
        program(password, { azureADOnlyAuthentication: true }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.azureADOnlyAuthentication === true,
        12,
      );
      expect(observed2.properties?.azureADOnlyAuthentication).toEqual(true);

      // Removing the resource allows SQL logins again.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.azureADOnlyAuthentication === false,
          12,
        )).properties?.azureADOnlyAuthentication,
      ).toEqual(false);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);

// Probe: without an Entra administrator Azure rejects the setting with a
// typed error. Needs a managed instance (~$0.40 per run), so it only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "entra-only authentication requires an entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;
      const { group, instance } = yield* stack.deploy(
        managedInstance(password),
      );
      const error = yield* sql
        .ManagedInstanceAzureADOnlyAuthenticationsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          managedInstanceName: instance.managedInstanceName,
          authenticationName: "Default",
          properties: { azureADOnlyAuthentication: true },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SqlManagedInstanceEntraAdminRequired");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
