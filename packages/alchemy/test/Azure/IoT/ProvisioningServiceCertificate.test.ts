import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  CA_CERT_1,
  CA_CERT_1_THUMBPRINT,
  CA_CERT_2,
  CA_CERT_2_THUMBPRINT,
} from "./fixtures/certificates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  provisioningServiceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* dps.GetDpsCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      provisioningServiceName,
      certificateName,
    });
  });

const program = (props: {
  name: string;
  certificate: string;
  isVerified: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.IoT.ProvisioningService("Dps", {
      resourceGroup: group.resourceGroupName,
    });
    const ca = yield* Azure.IoT.ProvisioningServiceCertificate("RootCa", {
      resourceGroup: group.resourceGroupName,
      provisioningService: service.provisioningServiceName,
      name: props.name,
      certificate: props.certificate,
      isVerified: props.isVerified,
    });
    return { group, service, ca };
  });

// DPS S1 has no fixed fee: ~$0. ~3 minutes end to end.
test.provider(
  "create, update, replace, and delete a DPS CA certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, ca } = yield* stack.deploy(
        program({ name: "root-ca", certificate: CA_CERT_1, isVerified: false }),
      );
      expect(ca.thumbprint).toEqual(CA_CERT_1_THUMBPRINT);
      expect(ca.isVerified).toBe(false);
      const get = (name: string) =>
        getCertificate(
          group.resourceGroupName,
          service.provisioningServiceName,
          name,
        );
      expect((yield* get("root-ca")).properties?.thumbprint).toEqual(
        CA_CERT_1_THUMBPRINT,
      );

      // In place: mark verified, then swap the certificate content.
      const verified = yield* stack.deploy(
        program({ name: "root-ca", certificate: CA_CERT_1, isVerified: true }),
      );
      expect(verified.ca.certificateId).toEqual(ca.certificateId);
      expect((yield* get("root-ca")).properties?.isVerified).toBe(true);

      const swapped = yield* stack.deploy(
        program({ name: "root-ca", certificate: CA_CERT_2, isVerified: true }),
      );
      expect(swapped.ca.certificateId).toEqual(ca.certificateId);
      expect((yield* get("root-ca")).properties?.thumbprint).toEqual(
        CA_CERT_2_THUMBPRINT,
      );

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({
          name: "root-ca-2",
          certificate: CA_CERT_2,
          isVerified: true,
        }),
      );
      expect(replaced.ca.certificateName).toEqual("root-ca-2");
      expect((yield* get("root-ca-2")).properties?.thumbprint).toEqual(
        CA_CERT_2_THUMBPRINT,
      );
      expect(yield* waitGone(get("root-ca"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("root-ca-2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
