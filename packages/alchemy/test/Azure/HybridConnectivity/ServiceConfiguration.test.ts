import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, machines, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (resourceUri: string, serviceConfigurationName: string) =>
  hybridconnectivity.GetServiceConfiguration({
    resourceUri,
    endpointName: "default",
    serviceConfigurationName,
  });

const program = (props: { scope: "A" | "B"; port: number }) =>
  Effect.gen(function* () {
    // Both machines and endpoints stay deployed across the replacement step.
    const { machineA, machineB } = yield* machines;
    const endpointA = yield* Azure.HybridConnectivity.Endpoint("EndpointA", {
      resourceUri: machineA.machineId,
    });
    const endpointB = yield* Azure.HybridConnectivity.Endpoint("EndpointB", {
      resourceUri: machineB.machineId,
    });
    const endpoint = props.scope === "A" ? endpointA : endpointB;
    const ssh = yield* Azure.HybridConnectivity.ServiceConfiguration("Ssh", {
      resourceUri: endpoint.resourceUri,
      endpointName: endpoint.endpointName,
      serviceName: "SSH",
      port: props.port,
    });
    return { machineA, machineB, ssh };
  });

// Free control-plane resources on pre-registered (unconnected) Arc
// machines; seconds.
test.provider(
  "create, update, replace, and delete a hybrid connectivity service configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { machineA, machineB, ssh } = yield* stack.deploy(
        program({ scope: "A", port: 22 }),
      );
      expect(ssh.serviceConfigurationName).toEqual("SSH");
      expect(ssh.port).toEqual(22);
      expect(
        (yield* getConfiguration(machineA.machineId, "SSH")).properties?.port,
      ).toEqual(22);

      // In-place: change the port.
      const updated = yield* stack.deploy(program({ scope: "A", port: 2222 }));
      expect(updated.ssh.serviceConfigurationId).toEqual(
        ssh.serviceConfigurationId,
      );
      expect(
        (yield* getConfiguration(machineA.machineId, "SSH")).properties?.port,
      ).toEqual(2222);

      // Replacement: move to the other machine's endpoint.
      const replaced = yield* stack.deploy(program({ scope: "B", port: 2222 }));
      expect(replaced.ssh.resourceUri).toEqual(machineB.machineId);
      expect(
        (yield* getConfiguration(machineB.machineId, "SSH")).properties?.port,
      ).toEqual(2222);
      expect(
        yield* waitGone(getConfiguration(machineA.machineId, "SSH")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getConfiguration(machineB.machineId, "SSH")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
