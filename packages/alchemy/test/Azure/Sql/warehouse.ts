import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { sqlServer } from "./harness.ts";

/**
 * A SQL server with a DW100c dedicated SQL pool (~$1.20/hour, 5-10
 * minutes to provision). Workload management only exists on dedicated
 * SQL pools, so these tests only run with AZURE_TEST_EXPENSIVE=1.
 */
export const warehouse = (password: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
    const dw = yield* Azure.Sql.Database("Warehouse", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: "DW100c" },
    });
    const scope = {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      database: dw.databaseName,
    };
    return { group, server, dw, scope };
  });
