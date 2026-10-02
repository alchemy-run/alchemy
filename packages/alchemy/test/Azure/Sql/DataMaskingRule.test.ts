import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  sqlDatabase,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const listRules = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const page = yield* sql.ListDataMaskingRuleByDatabase({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      dataMaskingPolicyName: "Default",
    });
    return page.value.filter(
      (rule) => rule.properties?.ruleState !== "Disabled",
    );
  });

const program = (
  password: Redacted.Redacted<string>,
  props: { name?: string; maskingFunction: "Email" | "Default" },
) =>
  Effect.gen(function* () {
    // The AdventureWorksLT sample provides a real column to mask.
    const { group, server, database } = yield* sqlDatabase(password, {
      sampleName: "AdventureWorksLT",
    });
    const scope = {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      database: database.databaseName,
    };
    yield* Azure.Sql.DataMaskingPolicy("Masking", {
      ...scope,
      dataMaskingState: "Enabled",
    });
    const rule = yield* Azure.Sql.DataMaskingRule("MaskEmail", {
      ...scope,
      name: props.name,
      schemaName: "SalesLT",
      tableName: "Customer",
      columnName: "EmailAddress",
      maskingFunction: props.maskingFunction,
    });
    return { group, server, database, rule };
  });

// A Basic database (~$0.007/hour) for ~5 minutes; masking is free.
test.provider(
  "create, update, replace, and disable a data masking rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, database, rule } = yield* stack.deploy(
        program(password, { maskingFunction: "Email" }),
      );
      const list = listRules(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      const observed = (yield* list).find(
        (r) => r.name === rule.dataMaskingRuleName,
      );
      expect(observed?.properties?.maskingFunction).toEqual("Email");
      expect(rule.column).toEqual("SalesLT.Customer.EmailAddress");

      // In place: switch the masking function.
      const updated = yield* stack.deploy(
        program(password, { maskingFunction: "Default" }),
      );
      expect(updated.rule.dataMaskingRuleName).toEqual(
        rule.dataMaskingRuleName,
      );
      expect(
        (yield* list).find((r) => r.name === rule.dataMaskingRuleName)
          ?.properties?.maskingFunction,
      ).toEqual("Default");

      // Renaming replaces the rule; the old one is disabled.
      const replaced = yield* stack.deploy(
        program(password, { name: "alchemy-mask", maskingFunction: "Default" }),
      );
      expect(replaced.rule.dataMaskingRuleName).toEqual("alchemy-mask");
      const names = (yield* list).map((r) => r.name);
      expect(names).toContain("alchemy-mask");
      expect(names).not.toContain(rule.dataMaskingRuleName);

      yield* stack.destroy();
      expect(
        yield* awaitGone(
          sql.GetDatabase({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serverName: server.serverName,
            databaseName: database.databaseName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
