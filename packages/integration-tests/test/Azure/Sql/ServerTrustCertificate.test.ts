import * as Azure from "@alchemy.run/azure";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { awaitGone, logLevel, newPassword, SQL_TAGS, subscription } from "./harness.ts";
import { managedInstance } from "./managed.ts";
import { TRUST_CERT_A, TRUST_CERT_B } from "./trust-certificates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  managedInstanceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetServerTrustCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      certificateName,
    });
  });

const program = (password: Redacted.Redacted<string>, publicBlob: string | undefined) =>
  Effect.gen(function* () {
    const mi = yield* managedInstance(password);
    const certificate =
      publicBlob === undefined
        ? undefined
        : yield* Azure.Sql.ServerTrustCertificate("Trust", {
            resourceGroup: mi.group.resourceGroupName,
            managedInstance: mi.instance.managedInstanceName,
            publicBlob,
          });
    return { ...mi, certificate };
  });

// ~$5/run, 30 min to 6 h: needs a SQL Managed Instance (~$0.70/hour; the
// first instance in a subnet builds a virtual cluster).
test.provider.skipIf(!runExpensive)(
  "upload, replace, and delete a server trust certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(program(password, TRUST_CERT_A));
      const rg = first.group.resourceGroupName;
      const instanceName = first.instance.managedInstanceName;
      const firstName = first.certificate!.certificateName;
      const observed = yield* getCertificate(rg, instanceName, firstName);
      expect(observed.properties?.publicBlob?.toUpperCase()).toEqual(TRUST_CERT_A);
      expect(first.certificate?.thumbprint).toEqual(observed.properties?.thumbprint);

      // A different certificate replaces the resource under a new generated
      // name, and the old upload is deleted.
      const second = yield* stack.deploy(program(password, TRUST_CERT_B));
      expect(second.certificate?.publicBlob).toEqual(TRUST_CERT_B);
      expect(second.certificate?.certificateName).not.toEqual(firstName);
      expect(yield* awaitGone(getCertificate(rg, instanceName, firstName))).toEqual("gone");
      expect(second.certificate?.thumbprint).not.toEqual(first.certificate?.thumbprint);
      expect(
        (yield* getCertificate(
          rg,
          instanceName,
          second.certificate!.certificateName,
        )).properties?.publicBlob?.toUpperCase(),
      ).toEqual(TRUST_CERT_B);

      yield* stack.deploy(program(password, undefined));
      expect(
        yield* awaitGone(getCertificate(rg, instanceName, second.certificate!.certificateName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
