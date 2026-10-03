import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as iothub from "@distilled.cloud/azure/iothub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  CA_CERT_1,
  CA_CERT_1_THUMBPRINT,
  CA_CERT_2,
  CA_CERT_2_THUMBPRINT,
} from "./fixtures/certificates.ts";
import { logLevel, subscription, tags, waitGone, withFreeHub } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* iothub.GetCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
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
    const hub = yield* Azure.IoTHub.IotHub("Hub", {
      resourceGroup: group.resourceGroupName,
      sku: "F1",
      partitionCount: 2,
    });
    const ca = yield* Azure.IoTHub.Certificate("RootCa", {
      resourceGroup: group.resourceGroupName,
      iotHub: hub.iotHubName,
      name: props.name,
      certificate: props.certificate,
      isVerified: props.isVerified,
    });
    return { group, hub, ca };
  });

// F1 hub: free. ~4 minutes end to end.
test.provider(
  "create, update, replace, and delete an IoT hub CA certificate",
  (stack) =>
    withFreeHub(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, hub, ca } = yield* stack.deploy(
          program({
            name: "root-ca",
            certificate: CA_CERT_1,
            isVerified: false,
          }),
        );
        expect(ca.thumbprint).toEqual(CA_CERT_1_THUMBPRINT);
        expect(ca.isVerified).toBe(false);
        expect(ca.subject).toContain("alchemy-iothub-test-ca-1");
        const get = (name: string) =>
          getCertificate(group.resourceGroupName, hub.iotHubName, name);
        expect((yield* get("root-ca")).properties?.thumbprint).toEqual(
          CA_CERT_1_THUMBPRINT,
        );

        // In-place: mark verified, then swap the certificate content.
        const verified = yield* stack.deploy(
          program({
            name: "root-ca",
            certificate: CA_CERT_1,
            isVerified: true,
          }),
        );
        expect(verified.ca.certificateId).toEqual(ca.certificateId);
        expect((yield* get("root-ca")).properties?.isVerified).toBe(true);

        const swapped = yield* stack.deploy(
          program({
            name: "root-ca",
            certificate: CA_CERT_2,
            isVerified: true,
          }),
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
    ),
  { tags, timeout: 900_000 },
);
