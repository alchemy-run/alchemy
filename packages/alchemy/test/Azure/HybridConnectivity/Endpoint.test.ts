import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, machines, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (resourceUri: string, endpointName: string) =>
  hybridconnectivity.GetEndpoint({ resourceUri, endpointName });

const program = (props: { scope: "A" | "B"; linked?: boolean }) =>
  Effect.gen(function* () {
    // Both machines stay deployed across the replacement step.
    const { machineA, machineB } = yield* machines;
    const machine = props.scope === "A" ? machineA : machineB;
    const endpoint = yield* Azure.HybridConnectivity.Endpoint("Endpoint", {
      resourceUri: machine.machineId,
      resourceId: props.linked ? machine.machineId : undefined,
    });
    return { machineA, machineB, endpoint };
  });

// Free control-plane resources on pre-registered (unconnected) Arc
// machines; seconds.
test.provider(
  "create, update, replace, and delete a hybrid connectivity endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { machineA, machineB, endpoint } = yield* stack.deploy(
        program({ scope: "A" }),
      );
      expect(endpoint.endpointName).toEqual("default");
      expect(endpoint.type).toEqual("default");
      expect(endpoint.endpointId.toLowerCase()).toEqual(
        `${machineA.machineId}/providers/Microsoft.HybridConnectivity/endpoints/default`.toLowerCase(),
      );
      expect(
        (yield* getEndpoint(machineA.machineId, "default")).properties?.type,
      ).toEqual("default");

      // Endpoints reject PATCH: linking a resource id recreates the endpoint
      // (delete first) at the same ARM id.
      const updated = yield* stack.deploy(
        program({ scope: "A", linked: true }),
      );
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      expect(
        (yield* getEndpoint(
          machineA.machineId,
          "default",
        )).properties?.resourceId?.toLowerCase(),
      ).toEqual(machineA.machineId.toLowerCase());

      // Replacement: move the endpoint to the other machine.
      const replaced = yield* stack.deploy(
        program({ scope: "B", linked: true }),
      );
      expect(replaced.endpoint.resourceUri).toEqual(machineB.machineId);
      expect(
        (yield* getEndpoint(machineB.machineId, "default")).properties?.type,
      ).toEqual("default");
      expect(
        yield* waitGone(getEndpoint(machineA.machineId, "default")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getEndpoint(machineB.machineId, "default")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
