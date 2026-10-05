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
    return yield* sql.GetManagedInstanceAdministrator({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      administratorName: "ActiveDirectory",
    });
  });

type Step = { login: string; sid: string };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password, {
      identity: { type: "SystemAssigned" },
    });
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceAdministrator("Setting", {
            resourceGroup: group.resourceGroupName,
            managedInstance: instance.managedInstanceName,
            ...step,
          });
    return { group, instance, setting };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1. Azure resolves the administrator through the
// instance's identity, which must hold the Entra "Directory Readers" role
// (a tenant-level grant); without it the create fails asynchronously with
// `ServicePrincipalLookupInAadFailed`, so this only runs when
// AZURE_TEST_SQL_MI_DIRECTORY_READERS=1 (a tenant where new managed instance
// identities are granted Directory Readers, e.g. via a group).
test.provider.skipIf(!runExpensive || !hasDirectoryReaders)(
  "set, update, and remove a managed instance entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          login: "alchemy-admins",
          sid: "00000000-0000-0000-0000-000000000001",
        }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.login === "alchemy-admins",
        12,
      );
      expect(observed1.properties?.sid).toEqual(
        "00000000-0000-0000-0000-000000000001",
      );

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          login: "alchemy-admins-2",
          sid: "00000000-0000-0000-0000-000000000002",
        }),
      );
      expect(second.setting?.administratorId).toEqual(
        first.setting?.administratorId,
      );
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.login === "alchemy-admins-2",
        12,
      );
      expect(observed2.properties?.sid).toEqual(
        "00000000-0000-0000-0000-000000000002",
      );

      // Removing the resource removes the administrator.
      yield* stack.deploy(program(password, undefined));
      expect(yield* awaitGone(get)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
