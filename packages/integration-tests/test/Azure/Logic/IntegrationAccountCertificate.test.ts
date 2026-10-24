import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { CERT_A, CERT_B } from "./certificates.ts";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; publicCertificate: string; owner: string }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns southcentralus.
    const { group, account } = yield* freeAccount("southcentralus");
    const certificate = yield* Azure.Logic.IntegrationAccountCertificate("Partner", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      publicCertificate: props.publicCertificate,
      metadata: { owner: props.owner },
    });
    return { group, account, certificate };
  });

const getCertificate = (rg: string, account: string, certificateName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      certificateName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, certificate } = yield* stack.deploy(
        program({ publicCertificate: CERT_A, owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(certificate.publicCertificate).toEqual(CERT_A);
      expect(certificate.metadata).toEqual({ owner: "a" });
      const observed = yield* getCertificate(rg, ia, certificate.certificateName);
      expect(observed.properties.publicCertificate).toEqual(CERT_A);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("Partner");

      // In-place: a rotated public certificate and metadata.
      const updated = yield* stack.deploy(program({ publicCertificate: CERT_B, owner: "b" }));
      expect(updated.certificate.certificateId).toEqual(certificate.certificateId);
      expect(updated.certificate.publicCertificate).toEqual(CERT_B);
      const reobserved = yield* getCertificate(rg, ia, certificate.certificateName);
      expect(reobserved.properties.publicCertificate).toEqual(CERT_B);
      expect((reobserved.properties.metadata as Record<string, unknown>).owner).toEqual("b");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "partner-v2", publicCertificate: CERT_B, owner: "b" }),
      );
      expect(replaced.certificate.certificateName).toEqual("partner-v2");
      expect(yield* waitGone(getCertificate(rg, ia, certificate.certificateName))).toEqual("gone");
      const replacedObserved = yield* getCertificate(rg, ia, "partner-v2");
      expect(replacedObserved.properties.publicCertificate).toEqual(CERT_B);

      yield* stack.destroy();
      expect(yield* waitGone(getCertificate(rg, ia, "partner-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
