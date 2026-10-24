import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  identities: { qualifier: string; value: string }[];
  owner: string;
}) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns centralus.
    const { group, account } = yield* freeAccount("centralus");
    const partner = yield* Azure.Logic.IntegrationAccountPartner("Contoso", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      businessIdentities: props.identities,
      metadata: { owner: props.owner },
    });
    return { group, account, partner };
  });

const getPartner = (rg: string, account: string, partnerName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountPartner({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      partnerName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account partner",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, partner } = yield* stack.deploy(
        program({ identities: [{ qualifier: "ZZ", value: "CONTOSO" }], owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(partner.businessIdentities).toEqual([{ qualifier: "ZZ", value: "CONTOSO" }]);
      expect(partner.metadata).toEqual({ owner: "a" });
      const observed = yield* getPartner(rg, ia, partner.partnerName);
      expect(observed.properties.partnerType).toEqual("B2B");
      expect(observed.properties.content.b2b?.businessIdentities).toEqual([
        { qualifier: "ZZ", value: "CONTOSO" },
      ]);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("Contoso");

      // In-place: business identities and metadata.
      const identities = [
        { qualifier: "ZZ", value: "CONTOSO" },
        { qualifier: "AS2Identity", value: "contoso-as2" },
      ];
      const updated = yield* stack.deploy(program({ identities, owner: "b" }));
      expect(updated.partner.partnerId).toEqual(partner.partnerId);
      const reobserved = yield* getPartner(rg, ia, partner.partnerName);
      expect(reobserved.properties.content.b2b?.businessIdentities).toEqual(identities);
      expect((reobserved.properties.metadata as Record<string, unknown>).owner).toEqual("b");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(program({ name: "contoso-v2", identities, owner: "b" }));
      expect(replaced.partner.partnerName).toEqual("contoso-v2");
      expect(yield* waitGone(getPartner(rg, ia, partner.partnerName))).toEqual("gone");
      const replacedObserved = yield* getPartner(rg, ia, "contoso-v2");
      expect(replacedObserved.properties.content.b2b?.businessIdentities).toEqual(identities);

      yield* stack.destroy();
      expect(yield* waitGone(getPartner(rg, ia, "contoso-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
