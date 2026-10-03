import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  fixturePublicKey,
  fixtureVmId,
  logLevel,
  subscription,
  tags,
  waitAbsent,
  whileLookupFails,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Observed through the list: GET intermittently fails with
// GuestConfigurationMachineInfoUnavailable.
const getAssignment = (
  resourceGroupName: string,
  machineName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const page = yield* guestconfiguration
      .ListGuestConfigurationHCRPAssignments({
        subscriptionId: yield* subscription,
        resourceGroupName,
        machineName,
      })
      .pipe(
        Effect.retry(whileLookupFails),
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.succeed({ value: [] }),
        ),
      );
    return (page.value ?? []).find((a) => a.name === name);
  });

const program = (props: {
  configurationName: string;
  assignmentType: Azure.GuestConfiguration.AssignmentType;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Pre-registered without an agent (AwaitingConnection): ARM accepts
    // assignments, which stay Pending. A short machine name keeps the
    // assignment ID under Azure's 253-character limit.
    const machine = yield* Azure.HybridCompute.Machine("Machine", {
      resourceGroup: group.resourceGroupName,
      name: "gc-arc",
      vmId: fixtureVmId,
      clientPublicKey: fixturePublicKey,
      osType: "linux",
    });
    const assignment = yield* Azure.GuestConfiguration.HybridMachineAssignment(
      "Baseline",
      {
        resourceGroup: group.resourceGroupName,
        machine: machine.machineName,
        configurationName: props.configurationName,
        configurationVersion: "1.*",
        assignmentType: props.assignmentType,
      },
    );
    return { group, machine, assignment };
  });

// Free (an unconnected Arc machine record plus assignments), ~2 minutes.
test.provider(
  "create, update, replace, and delete an Arc machine assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine, assignment } = yield* stack.deploy(
        program({
          configurationName: "AzureLinuxBaseline",
          assignmentType: "Audit",
        }),
      );
      const rg = group.resourceGroupName;
      const machineName = machine.machineName;
      expect(assignment.assignmentName).toEqual("AzureLinuxBaseline");
      expect(assignment.machine).toEqual(machineName);
      expect(assignment.location.toLowerCase()).toEqual("eastus");
      const observed = yield* getAssignment(
        rg,
        machineName,
        "AzureLinuxBaseline",
      );
      expect(observed?.properties?.guestConfiguration?.version).toEqual("1.*");
      expect(observed?.properties?.guestConfiguration?.assignmentType).toEqual(
        "Audit",
      );

      // In place: assignment type.
      const updated = yield* stack.deploy(
        program({
          configurationName: "AzureLinuxBaseline",
          assignmentType: "ApplyAndMonitor",
        }),
      );
      expect(updated.assignment.assignmentId).toEqual(assignment.assignmentId);
      const reobserved = yield* getAssignment(
        rg,
        machineName,
        "AzureLinuxBaseline",
      );
      expect(
        reobserved?.properties?.guestConfiguration?.assignmentType,
      ).toEqual("ApplyAndMonitor");

      // Replacement: another configuration package.
      const replaced = yield* stack.deploy(
        program({
          configurationName: "LinuxSshServerSecurityBaseline",
          assignmentType: "Audit",
        }),
      );
      expect(replaced.assignment.assignmentName).toEqual(
        "LinuxSshServerSecurityBaseline",
      );
      expect(
        yield* waitAbsent(getAssignment(rg, machineName, "AzureLinuxBaseline")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitAbsent(
          getAssignment(rg, machineName, "LinuxSshServerSecurityBaseline"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
