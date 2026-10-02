import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  PFX_ONE,
  PFX_ONE_THUMBPRINT,
  PFX_PASSWORD,
  PFX_TWO,
  PFX_TWO_THUMBPRINT,
} from "./certificates.ts";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  serviceName: string,
  certificateId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetCertificate({
      subscriptionId,
      resourceGroupName,
      serviceName,
      certificateId,
    }),
  );

const program = (cert?: { name: string; data: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = cert
      ? yield* Azure.ApiManagement.Certificate("Client", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: cert.name,
          data: Redacted.make(cert.data),
          password: Redacted.make(PFX_PASSWORD),
        })
      : undefined;
    return { group, service, certificate: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "upload, rotate, replace, and delete a certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-client", data: PFX_ONE }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.certificate?.certificateName).toEqual("alchemy-client");
      expect(first.certificate?.thumbprint).toEqual(PFX_ONE_THUMBPRINT);
      const observed = yield* getCertificate(rg, svc, "alchemy-client");
      expect(observed.properties?.thumbprint).toEqual(PFX_ONE_THUMBPRINT);
      expect(observed.properties?.subject).toContain(
        "alchemy-apim-test-one.example.com",
      );

      // In-place update: rotate the PFX under the same identifier.
      const rotated = yield* stack.deploy(
        program({ name: "alchemy-client", data: PFX_TWO }),
      );
      expect(rotated.certificate?.thumbprint).toEqual(PFX_TWO_THUMBPRINT);
      expect(
        (yield* getCertificate(rg, svc, "alchemy-client")).properties
          ?.thumbprint,
      ).toEqual(PFX_TWO_THUMBPRINT);

      // Replacement: a new identifier creates a new certificate and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-client-v2", data: PFX_TWO }),
      );
      expect(replaced.certificate?.certificateName).toEqual(
        "alchemy-client-v2",
      );
      expect(
        (yield* getCertificate(rg, svc, "alchemy-client-v2")).properties
          ?.thumbprint,
      ).toEqual(PFX_TWO_THUMBPRINT);
      expect(
        yield* untilGone(getCertificate(rg, svc, "alchemy-client")),
      ).toEqual("gone");

      // Removing the resource deletes the certificate.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getCertificate(rg, svc, "alchemy-client-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
