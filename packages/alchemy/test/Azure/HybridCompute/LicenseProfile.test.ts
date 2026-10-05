import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  connectedWindowsMachine,
  fixturePublicKey,
  fixtureVmId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const [resourceGroup = "", machineName = ""] = connectedWindowsMachine ?? [];

const getProfile = (resourceGroupName: string, machine: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetLicenseProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      machineName: machine,
      licenseProfileName: "default",
    });
  });

const program = (props: { softwareAssuranceCustomer: boolean }) =>
  Azure.HybridCompute.LicenseProfile("Profile", {
    resourceGroup,
    machineName,
    softwareAssuranceCustomer: props.softwareAssuranceCustomer,
    tags: { env: "test" },
  }).pipe(Effect.map((profile) => ({ profile })));

// License profiles need a connected Windows Server Arc machine
// (AZURE_TEST_ARC_WINDOWS_MACHINE=<rg>/<machine>); the free trial has
// none. Declaring Software Assurance is free.
test.provider.skipIf(!runPaidOnly || connectedWindowsMachine === undefined)(
  "create, update, and delete a license profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { profile } = yield* stack.deploy(
        program({ softwareAssuranceCustomer: true }),
      );
      expect(profile.softwareAssuranceCustomer).toEqual(true);
      const observed = yield* getProfile(resourceGroup, machineName);
      expect(
        observed.properties?.softwareAssurance?.softwareAssuranceCustomer,
      ).toEqual(true);

      // In-place: withdraw the Software Assurance declaration.
      yield* stack.deploy(program({ softwareAssuranceCustomer: false }));
      const reobserved = yield* getProfile(resourceGroup, machineName);
      expect(
        reobserved.properties?.softwareAssurance?.softwareAssuranceCustomer,
      ).toEqual(false);

      yield* stack.destroy();
      expect(yield* waitGone(getProfile(resourceGroup, machineName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: a pre-registered machine whose agent never connected
// rejects license profiles with the typed error.
test.provider(
  "an unconnected machine rejects license profiles with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const machine = yield* Azure.HybridCompute.Machine("Machine", {
            resourceGroup: group.resourceGroupName,
            vmId: fixtureVmId,
            clientPublicKey: fixturePublicKey,
            osType: "windows",
          });
          return { group, machine };
        }),
      );
      const error = yield* hybridcompute
        .LicenseProfilesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          machineName: machine.machineName,
          licenseProfileName: "default",
          location: machine.location,
          properties: {
            softwareAssurance: { softwareAssuranceCustomer: true },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ArcMachineNotConnected");
      expect(
        yield* waitGone(
          getProfile(group.resourceGroupName, machine.machineName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
