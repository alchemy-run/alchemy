import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { PUBLIC_KEY_1 } from "../Compute/helpers.ts";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFormula = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetFormulas({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: { description: string; size: string }) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const formula = yield* Azure.DevTestLabs.Formula("Ubuntu", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      description: props.description,
      osType: "Linux",
      formulaContent: {
        size: props.size,
        galleryImageReference: {
          publisher: "Canonical",
          offer: "0001-com-ubuntu-server-jammy",
          sku: "22_04-lts-gen2",
          osType: "Linux",
        },
        userName: "azureuser",
        isAuthenticationWithSshKey: true,
        sshKey: PUBLIC_KEY_1,
        storageType: "Standard",
      },
    });
    return { group, lab, formula };
  });

// Free lab + formula (no VM is created); ~5 minutes for the lab.
test.provider(
  "create, update, and delete a lab formula",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, formula } = yield* stack.deploy(
        program({ description: "first", size: "Standard_B1s" }),
      );
      const get = () =>
        getFormula(group.resourceGroupName, lab.labName, formula.formulaName);
      const observed = yield* get();
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.formulaContent?.properties?.size).toEqual(
        "Standard_B1s",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Ubuntu");

      // In-place: description + size.
      const updated = yield* stack.deploy(
        program({ description: "second", size: "Standard_B2s" }),
      );
      expect(updated.formula.formulaId).toEqual(formula.formulaId);
      const reobserved = yield* get();
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.properties?.formulaContent?.properties?.size).toEqual(
        "Standard_B2s",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
