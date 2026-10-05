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
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAlias = (
  resourceGroupName: string,
  managedInstanceName: string,
  dnsAliasName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedServerDnsAlias({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      dnsAliasName,
    });
  });

const program = (password: Redacted.Redacted<string>, name?: string) =>
  Effect.gen(function* () {
    const mi = yield* managedInstance(password);
    const alias = yield* Azure.Sql.ManagedServerDnsAlias("Alias", {
      resourceGroup: mi.group.resourceGroupName,
      managedInstance: mi.instance.managedInstanceName,
      name,
    });
    return { ...mi, alias };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1. The testing subscription's instances (centralus)
// do not serve the dnsAliases route at all: PUT and GET answer
// `ResourceNotFound` "The specified resource
// 'https://management.centralus.control.database.windows.net/modules/AzureResourceManager.dsts/.../dnsAliases/...' was not found."
// so it also needs AZURE_TEST_SQL_MI_DNS_ALIAS=1 (a subscription/region with
// managed instance DNS aliases enabled).
test.provider.skipIf(!runExpensive || !process.env.AZURE_TEST_SQL_MI_DNS_ALIAS)(
  "create, replace, and delete a managed instance dns alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;
      const first = yield* stack.deploy(program(password));
      const get = (name: string) =>
        getAlias(
          first.group.resourceGroupName,
          first.instance.managedInstanceName,
          name,
        );
      expect(
        (yield* get(first.alias.dnsAliasName)).properties?.azureDnsRecord,
      ).toEqual(first.alias.azureDnsRecord);
      const renamed = `${first.alias.dnsAliasName.slice(0, 36)}-alt`;
      const second = yield* stack.deploy(program(password, renamed));
      expect(second.alias.dnsAliasName).toEqual(renamed);
      expect(yield* awaitGone(get(first.alias.dnsAliasName))).toEqual("gone");
      yield* stack.destroy();
      expect(yield* awaitGone(get(renamed))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
