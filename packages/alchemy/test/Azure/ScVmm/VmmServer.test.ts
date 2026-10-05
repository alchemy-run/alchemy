import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as scvmm from "@distilled.cloud/azure/scvmm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  logLevel,
  missingCustomLocation,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { owner: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vmm = yield* Azure.ScVmm.VmmServer("Vmm", {
      resourceGroup: group.resourceGroupName,
      extendedLocation: { name: customLocationId() },
      fqdn: process.env.AZURE_TEST_SCVMM_FQDN ?? "",
      username: process.env.AZURE_TEST_SCVMM_USERNAME,
      password: Redacted.make(process.env.AZURE_TEST_SCVMM_PASSWORD ?? ""),
      tags: { owner: props.owner },
    });
    return { group, vmm };
  });

// Connects a real on-premises VMM server through an Arc resource bridge
// (Azure cannot provision SCVMM itself). Run with AZURE_TEST_PAID=1,
// AZURE_TEST_SCVMM_CUSTOM_LOCATION, AZURE_TEST_SCVMM_FQDN,
// AZURE_TEST_SCVMM_USERNAME and AZURE_TEST_SCVMM_PASSWORD.
test.provider.skipIf(
  !runPaidOnly ||
    !customLocationId() ||
    !process.env.AZURE_TEST_SCVMM_FQDN,
)(
  "connect, retag, and disconnect a VMM server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vmm } = yield* stack.deploy(program({ owner: "a" }));
      const where = {
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        vmmServerName: vmm.vmmServerName,
      };
      expect((yield* scvmm.GetVmmServer(where)).tags?.owner).toEqual("a");

      // In place: tags.
      const retagged = yield* stack.deploy(program({ owner: "b" }));
      expect(retagged.vmm.vmmServerId).toEqual(vmm.vmmServerId);
      expect((yield* scvmm.GetVmmServer(where)).tags?.owner).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(scvmm.GetVmmServer(where))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): a missing custom location rejects the VMM server
// with the typed error, and nothing is left behind.
test.provider(
  "a missing custom location rejects a VMM server with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const where = {
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        vmmServerName: "probe",
      };
      const error = yield* scvmm
        .VmmServersCreateOrUpdate({
          ...where,
          location: "eastus",
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(subscriptionId, group.resourceGroupName),
          },
          properties: { fqdn: "vmm.contoso.local" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* scvmm.GetVmmServer(where).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
