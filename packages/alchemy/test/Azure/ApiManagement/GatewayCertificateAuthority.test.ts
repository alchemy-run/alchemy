import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { PFX_ONE, PFX_PASSWORD, PFX_TWO } from "./certificates.ts";
import {
  developerGateway,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAuthority = (
  resourceGroupName: string,
  serviceName: string,
  certificateId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGatewayCertificateAuthority({
      subscriptionId,
      resourceGroupName,
      serviceName,
      gatewayId: "alchemy-edge",
      certificateId,
    }),
  );

const program = (authority?: { cert: "one" | "two"; isTrusted: boolean }) =>
  Effect.gen(function* () {
    const { group, service, gateway } = yield* developerGateway;
    // Both certificates stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Certificate("CaOne", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-ca-one",
      data: Redacted.make(PFX_ONE),
      password: Redacted.make(PFX_PASSWORD),
    });
    const two = yield* Azure.ApiManagement.Certificate("CaTwo", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-ca-two",
      data: Redacted.make(PFX_TWO),
      password: Redacted.make(PFX_PASSWORD),
    });
    const created = authority
      ? yield* Azure.ApiManagement.GatewayCertificateAuthority("Ca", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          gatewayName: gateway.gatewayName,
          certificateName:
            authority.cert === "one"
              ? one.certificateName
              : two.certificateName,
          isTrusted: authority.isTrusted,
        })
      : undefined;
    return { group, service, authority: created };
  });

// Self-hosted gateways need the Developer (or Premium) tier: ~$0.07/h but
// 30-45 min to create (plus ~15 min to delete): est. ~$0.10 and ~60
// minutes per run.
test.provider.skipIf(!runExpensive)(
  "add, update, replace, and remove a gateway certificate authority",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ cert: "one", isTrusted: false }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.authority?.certificateName).toEqual("alchemy-ca-one");
      expect(
        (yield* getAuthority(rg, svc, "alchemy-ca-one")).properties?.isTrusted,
      ).toEqual(false);

      // In-place update: trust the CA.
      yield* stack.deploy(program({ cert: "one", isTrusted: true }));
      expect(
        (yield* getAuthority(rg, svc, "alchemy-ca-one")).properties?.isTrusted,
      ).toEqual(true);

      // Replacement: another CA certificate.
      yield* stack.deploy(program({ cert: "two", isTrusted: true }));
      expect(
        (yield* getAuthority(rg, svc, "alchemy-ca-two")).properties?.isTrusted,
      ).toEqual(true);
      expect(yield* untilGone(getAuthority(rg, svc, "alchemy-ca-one"))).toEqual(
        "gone",
      );

      // Removing the resource removes the CA from the gateway.
      yield* stack.deploy(program());
      expect(yield* untilGone(getAuthority(rg, svc, "alchemy-ca-two"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
