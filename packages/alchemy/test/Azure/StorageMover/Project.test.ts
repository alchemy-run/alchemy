import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagemover from "@distilled.cloud/azure/storagemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProject = (
  resourceGroupName: string,
  storageMoverName: string,
  projectName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    storagemover.GetProject({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      projectName,
    }),
  );

const program = (props: { mover: "A" | "B"; description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both movers stay deployed across the replacement step.
    const moverA = yield* Azure.StorageMover.StorageMover("MoverA", {
      resourceGroup: group.resourceGroupName,
    });
    const moverB = yield* Azure.StorageMover.StorageMover("MoverB", {
      resourceGroup: group.resourceGroupName,
    });
    const mover = props.mover === "A" ? moverA : moverB;
    const project = yield* Azure.StorageMover.Project("Project", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      description: props.description,
    });
    return { group, mover, project };
  });

// Storage Movers and projects are free; the lifecycle takes a few minutes.
test.provider(
  "create, update, replace, and delete a storage mover project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, mover, project } = yield* stack.deploy(
        program({ mover: "A", description: "first" }),
      );
      const get = (moverName: string, name: string) =>
        getProject(group.resourceGroupName, moverName, name);
      expect(project.description).toEqual("first");
      const observed = yield* get(mover.storageMoverName, project.projectName);
      expect(observed.properties?.description).toMatch(
        /^first \[alchemy .+\/Project\]$/,
      );

      // In-place: description.
      const updated = yield* stack.deploy(
        program({ mover: "A", description: "second" }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      expect(updated.project.description).toEqual("second");
      const reobserved = yield* get(
        mover.storageMoverName,
        project.projectName,
      );
      expect(reobserved.properties?.description).toMatch(/^second \[alchemy /);

      // Replacement: move the project to another Storage Mover.
      const replaced = yield* stack.deploy(
        program({ mover: "B", description: "second" }),
      );
      expect(replaced.project.storageMover).toEqual(
        replaced.mover.storageMoverName,
      );
      expect(replaced.project.storageMover).not.toEqual(mover.storageMoverName);
      const moved = yield* get(
        replaced.mover.storageMoverName,
        replaced.project.projectName,
      );
      expect(moved.properties?.description).toMatch(/^second \[alchemy /);
      expect(
        yield* waitGone(get(mover.storageMoverName, project.projectName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(replaced.mover.storageMoverName, replaced.project.projectName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
