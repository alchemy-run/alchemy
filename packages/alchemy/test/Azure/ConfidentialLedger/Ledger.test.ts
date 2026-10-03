import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confidentialledger from "@distilled.cloud/azure/confidentialledger";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  callerObjectId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLedger = (resourceGroupName: string, ledgerName: string) =>
  Effect.gen(function* () {
    return yield* confidentialledger.GetLedger({
      subscriptionId: yield* subscription,
      resourceGroupName,
      ledgerName,
    });
  });

// The deploying identity is the ledger Administrator: the service applies
// principal changes through the ledger's data plane as the caller.
const program = (props: {
  admin: string;
  group: string;
  withReader: boolean;
  ledgerType?: "Public" | "Private";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // Confidential Ledger rejects resource group names over 63 characters,
    // so the (up to 90-char) engine default is replaced by a short constant.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: props.group,
      location: "eastus",
    });
    const reader = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Reader",
      { resourceGroup: group.resourceGroupName },
    );
    const ledger = yield* Azure.ConfidentialLedger.Ledger("Ledger", {
      resourceGroup: group.resourceGroupName,
      ledgerType: props.ledgerType,
      aadBasedSecurityPrincipals: [
        { principalId: props.admin, ledgerRoleName: "Administrator" },
        ...(props.withReader
          ? [
              {
                principalId: reader.principalId,
                ledgerRoleName: "Reader" as const,
              },
            ]
          : []),
      ],
      tags: props.tags,
    });
    return { group, reader, ledger };
  });

// Standard ledger: ~$3/day (~$0.13/hour) while running. Create ~4 min
// (the endpoint takes that long to publish), delete ~2-5 min — about $0.03.
test.provider(
  "create, update, and delete a confidential ledger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const admin = yield* callerObjectId;
      const group = "alchemy-test-confidentialledger";
      const { ledger } = yield* stack.deploy(
        program({ admin, group, withReader: false, tags: { env: "test" } }),
      );
      expect(ledger.ledgerSku).toEqual("Standard");
      expect(ledger.ledgerType).toEqual("Public");
      expect(ledger.ledgerUri).toMatch(/^https:\/\//);
      const observed = yield* getLedger(group, ledger.ledgerName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();
      expect(
        observed.properties?.aadBasedSecurityPrincipals?.map(
          (p) => p.principalId,
        ),
      ).toEqual([admin]);

      // In-place: tags and an extra Reader principal.
      const updated = yield* stack.deploy(
        program({ admin, group, withReader: true, tags: { env: "prod" } }),
      );
      expect(updated.ledger.ledgerId).toEqual(ledger.ledgerId);
      const reobserved = yield* getLedger(group, ledger.ledgerName);
      expect(reobserved.tags?.env).toEqual("prod");
      const principals = reobserved.properties?.aadBasedSecurityPrincipals ?? [];
      expect(
        principals.find((p) => p.principalId === updated.reader.principalId)
          ?.ledgerRoleName,
      ).toEqual("Reader");

      yield* stack.destroy();
      expect(yield* waitGone(getLedger(group, ledger.ledgerName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Replacement creates a second ledger (~4 min) and deletes the first, then
// destroys everything: ~15-20 minutes end to end (cost ~$0.05), past the
// ~10 minute budget for ungated runs.
test.provider.skipIf(!runExpensive)(
  "replace a confidential ledger when its type changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const admin = yield* callerObjectId;
      const group = "alchemy-test-confidentialledger-replace";
      const { ledger } = yield* stack.deploy(
        program({ admin, group, withReader: false }),
      );
      expect(ledger.ledgerType).toEqual("Public");

      const replaced = yield* stack.deploy(
        program({ admin, group, withReader: false, ledgerType: "Private" }),
      );
      expect(replaced.ledger.ledgerName).not.toEqual(ledger.ledgerName);
      expect(replaced.ledger.ledgerType).toEqual("Private");
      const observed = yield* getLedger(group, replaced.ledger.ledgerName);
      expect(observed.properties?.ledgerType).toEqual("Private");
      expect(yield* waitGone(getLedger(group, ledger.ledgerName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getLedger(group, replaced.ledger.ledgerName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
