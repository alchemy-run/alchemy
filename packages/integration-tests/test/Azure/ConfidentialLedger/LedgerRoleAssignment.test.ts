import * as Azure from "@alchemy.run/azure";
import * as confidentialledger from "@distilled.cloud/azure/confidentialledger";
import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as identity from "@distilled.cloud/azure/confidentialledger-identity";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { callerObjectId, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** The ledger roles of `userId` as the deployer sees them (`[]` when not a user). */
const rolesOf = (ledgerName: string, userId: string) =>
  Effect.gen(function* () {
    const ledgerIdentity = yield* identity.GetLedgerIdentity({ ledgerId: ledgerName });
    return yield* data
      .GetLedgerUser({
        ledgerEndpoint: `https://${ledgerName}.confidential-ledger.azure.com`,
        userId,
      })
      .pipe(
        Effect.map((user) => [...user.assignedRoles].sort()),
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
        Effect.provide(
          NodeHttpClient.layerNodeHttpOptions({ ca: ledgerIdentity.ledgerTlsCertificate }),
        ),
      );
  });

// The deploying identity administers the ledger: the assignments go through
// the ledger's data plane as the caller.
type Role = "Reader" | "Contributor" | "Administrator";

const program = (props: { admin: string; assignments: Record<string, Role> }) =>
  Effect.gen(function* () {
    // Confidential Ledger rejects resource group names over 63 characters.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-cl-roleassignment",
      location: "eastus",
    });
    const app = yield* Azure.ManagedIdentity.UserAssignedIdentity("App", {
      resourceGroup: group.resourceGroupName,
    });
    const ledger = yield* Azure.ConfidentialLedger.Ledger("Ledger", {
      resourceGroup: group.resourceGroupName,
      aadBasedSecurityPrincipals: [{ principalId: props.admin, ledgerRoleName: "Administrator" }],
    });
    for (const [id, role] of Object.entries(props.assignments)) {
      yield* Azure.ConfidentialLedger.LedgerRoleAssignment(id, {
        ledger: ledger.ledgerName,
        principalId: app.principalId,
        role,
      });
    }
    return { ledger, app };
  });

// Standard ledger: ~$0.13/hour while running. Create ~4 min, delete ~3 min:
// about $0.03 per run, ~10 minutes.
test.provider(
  "assign, remove, replace, and delete ledger roles",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const admin = yield* callerObjectId;

      // Two assignments of the same principal race on its role list.
      const { ledger, app } = yield* stack.deploy(
        program({ admin, assignments: { AppRead: "Reader", AppWrite: "Contributor" } }),
      );
      expect(yield* rolesOf(ledger.ledgerName, app.principalId)).toEqual(["Contributor", "Reader"]);

      // Removing one assignment keeps the other role.
      yield* stack.deploy(program({ admin, assignments: { AppWrite: "Contributor" } }));
      expect(yield* rolesOf(ledger.ledgerName, app.principalId)).toEqual(["Contributor"]);

      // Changing the role replaces the assignment: the new role is added, the old one removed.
      yield* stack.deploy(program({ admin, assignments: { AppWrite: "Administrator" } }));
      expect(yield* rolesOf(ledger.ledgerName, app.principalId)).toEqual(["Administrator"]);

      // Removing the last assignment deletes the ledger user.
      yield* stack.deploy(program({ admin, assignments: {} }));
      expect(yield* rolesOf(ledger.ledgerName, app.principalId)).toEqual([]);

      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      expect(
        yield* waitGone(
          confidentialledger.GetLedger({
            subscriptionId,
            resourceGroupName: "alchemy-test-cl-roleassignment",
            ledgerName: ledger.ledgerName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
