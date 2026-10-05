import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  lakeSqlPool,
  logLevel,
  poolPath,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (
  value: string,
  dataMaskingState: "Enabled" | "Disabled" = "Enabled",
) =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const resource = yield* Azure.Synapse.SqlPoolDataMaskingPolicy("Masking", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      exemptPrincipals: value,
      dataMaskingState,
    });
    return { pool, resource };
  });

const observe = (pool: {
  resourceGroup: string;
  workspaceName: string;
  sqlPoolName: string;
}) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetDataMaskingPolicy({
      ...path,
      dataMaskingPolicyName: "Default",
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "enable and disable a synapse sql pool data masking policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Exempt principals must be existing database users; a fresh pool only
      // has the built-in `dbo` (always exempt, dropped by Azure) and `guest`.
      // Azure keeps masking `Enabled` only while something is exempt or
      // masked.
      const created = yield* stack.deploy(program("guest"));
      const before = (yield* observe(created.pool)).properties;
      expect(before?.dataMaskingState).toEqual("Enabled");
      // Azure stores the list with a trailing `;`.
      expect(
        (before?.exemptPrincipals ?? "").split(";").filter((p) => p !== ""),
      ).toEqual(["guest"]);

      // In place: disabling masking clears the exempt list.
      const updated = yield* stack.deploy(program("guest", "Disabled"));
      expect(updated.resource.settingId).toEqual(created.resource.settingId);
      const after = (yield* observe(updated.pool)).properties;
      expect(after?.dataMaskingState).toEqual("Disabled");
      expect(after?.exemptPrincipals ?? "").toEqual("");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
