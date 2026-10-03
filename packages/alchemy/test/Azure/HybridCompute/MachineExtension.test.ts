import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  connectedMachine,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const [resourceGroup = "", machineName = ""] = connectedMachine ?? [];

const getExtension = (extensionName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetMachineExtension({
      subscriptionId: yield* subscription,
      resourceGroupName: resourceGroup,
      machineName,
      extensionName,
    });
  });

const program = (props: { name?: string; command: string }) =>
  Azure.HybridCompute.MachineExtension("Extension", {
    resourceGroup,
    machineName,
    name: props.name,
    publisher: "Microsoft.Azure.Extensions",
    type: "CustomScript",
    typeHandlerVersion: "2.1",
    settings: { commandToExecute: props.command },
    tags: { env: "test" },
  }).pipe(Effect.map((extension) => ({ extension })));

// Extensions are installed by the Connected Machine agent, so this needs a
// connected Linux Arc server (AZURE_TEST_ARC_MACHINE=<rg>/<machine>); the
// free trial has none. On a pre-registered (unconnected) machine the PUT
// is accepted but the extension never materializes.
test.provider.skipIf(!runPaidOnly || connectedMachine === undefined)(
  "install, update, replace, and remove a machine extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { extension } = yield* stack.deploy(
        program({ command: "echo one" }),
      );
      expect(extension.extensionName).toEqual("CustomScript");
      expect(extension.provisioningState).toEqual("Succeeded");
      const observed = yield* getExtension(extension.extensionName);
      expect(observed.properties?.settings?.commandToExecute).toEqual(
        "echo one",
      );

      // In-place: new settings re-run the handler.
      yield* stack.deploy(program({ command: "echo two" }));
      const reobserved = yield* getExtension(extension.extensionName);
      expect(reobserved.properties?.settings?.commandToExecute).toEqual(
        "echo two",
      );

      // Replacement: a new extension name.
      const replaced = yield* stack.deploy(
        program({ name: "CustomScriptB", command: "echo two" }),
      );
      expect(replaced.extension.extensionName).toEqual("CustomScriptB");
      expect(yield* waitGone(getExtension("CustomScript"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getExtension("CustomScriptB"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
