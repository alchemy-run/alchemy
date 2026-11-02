import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as automation from "@distilled.cloud/stackit/automation";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { RARELY, RARELY_WEEKLY, recoveryPointTemplateId } from "./templates.ts";

const { test } = makeStackitTest();

// An automation costs nothing, its schedule never fires in a run, and no volume matches these
// selectors, so no snapshot is taken: EUR 0, ungated.
const options = {
  tags: stackitTags("automation", "volumeautomation"),
  timeout: 240_000,
} as const;

const input = {
  volumeLabelSelector: "alchemy-automation-test=none",
  snapshotRetentionPolicy: { kind: "indefinitely" },
} as const;

/** Bounded check that an automation reads as gone. */
const expectGone = (scope: { projectId: string; region: string }, automationId: string) =>
  automation.getVolumeAutomation({ ...scope, automationId }).pipe(
    Effect.map(() => "present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (state) => state === "gone",
      times: 10,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

const deleteOutOfBand = (scope: { projectId: string; region: string }, automationId: string) =>
  automation
    .deleteVolumeAutomation({ ...scope, automationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

test.provider(
  "create an automation, update it in place, and delete only it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      const templateId = yield* recoveryPointTemplateId(scope);
      yield* stack.destroy();

      const props = { templateId, schedule: RARELY, input };
      const created = yield* stack.deploy(Stackit.Automation.VolumeAutomation("Basic", props));
      const automationId = created.automationId;
      expect(automationId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.schedule).toEqual(RARELY);

      const fetched = yield* automation.getVolumeAutomation({ ...scope, automationId });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.templateId).toEqual(templateId);
      expect(fetched.triggers?.schedule?.rrule).toEqual(RARELY);
      expect(fetched.input).toMatchObject({
        kind: "VolumeRecoveryPointManagement",
        volumeLabelSelector: "alchemy-automation-test=none",
        snapshotRetentionPolicy: { kind: "indefinitely" },
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Automation.VolumeAutomation("Basic", props));
      expect(plan.resources.Basic).toMatchObject({ action: "noop" });

      // The generated name is what `nuke` enumerates.
      const provider = yield* Provider.findProvider(Stackit.Automation.VolumeAutomation);
      const listed = yield* provider.list();
      expect(listed.map((item) => item.automationId)).toContain(automationId);

      // A change to one aspect leaves its neighbours alone.
      yield* stack.deploy(
        Stackit.Automation.VolumeAutomation("Basic", {
          ...props,
          description: "alchemy test automation",
        }),
      );
      const described = yield* automation.getVolumeAutomation({ ...scope, automationId });
      expect(described.description).toEqual("alchemy test automation");
      expect(described.name).toEqual(created.name);
      expect(described.triggers?.schedule?.rrule).toEqual(RARELY);
      expect(described.input).toMatchObject({ volumeLabelSelector: input.volumeLabelSelector });

      // Every mutable aspect updates in place, under the same id. The input is replaced whole, so
      // a member the new one drops doesn't stay.
      const updated = yield* stack.deploy(
        Stackit.Automation.VolumeAutomation("Basic", {
          templateId,
          name: "alchemy-test-automation-renamed",
          description: "alchemy test automation, updated",
          schedule: RARELY_WEEKLY,
          input: {
            recoveryPointLabels: { "created-by": "alchemy-test" },
            snapshotRetentionPolicy: { kind: "count", value: 2 },
          },
        }),
      );
      expect(updated.automationId).toEqual(automationId);
      const changed = yield* automation.getVolumeAutomation({ ...scope, automationId });
      expect(changed.name).toEqual("alchemy-test-automation-renamed");
      expect(changed.description).toEqual("alchemy test automation, updated");
      expect(changed.triggers?.schedule?.rrule).toEqual(RARELY_WEEKLY);
      expect(changed.input).toMatchObject({
        recoveryPointLabels: { "created-by": "alchemy-test" },
        snapshotRetentionPolicy: { kind: "count", value: 2 },
      });
      expect(changed.input?.volumeLabelSelector ?? "").toEqual("");

      // Removing the schedule removes the trigger, and nothing else.
      const unscheduled = yield* stack.deploy(
        Stackit.Automation.VolumeAutomation("Basic", {
          templateId,
          name: "alchemy-test-automation-renamed",
          input: {
            recoveryPointLabels: { "created-by": "alchemy-test" },
            snapshotRetentionPolicy: { kind: "count", value: 2 },
          },
        }),
      );
      expect(unscheduled.schedule).toBeUndefined();
      const stopped = yield* automation.getVolumeAutomation({ ...scope, automationId });
      expect(stopped.triggers?.schedule?.rrule).toBeUndefined();
      expect(stopped.name).toEqual("alchemy-test-automation-renamed");
      expect(stopped.input).toMatchObject({
        snapshotRetentionPolicy: { kind: "count", value: 2 },
      });

      // An automation this stack didn't make survives the destroy.
      const foreign = yield* automation.createVolumeAutomation({
        ...scope,
        templateId,
        name: "alchemy-test-other-automation",
        input: { ...input, kind: "VolumeRecoveryPointManagement" },
      });
      yield* Effect.gen(function* () {
        yield* stack.destroy();
        yield* expectGone(scope, automationId);
        const survivor = yield* automation.getVolumeAutomation({
          ...scope,
          automationId: foreign.id,
        });
        expect(survivor.name).toEqual("alchemy-test-other-automation");
      }).pipe(Effect.ensuring(deleteOutOfBand(scope, foreign.id).pipe(Effect.ignore)));
      yield* expectGone(scope, foreign.id);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an explicit name found without state is unowned until adopted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      const templateId = yield* recoveryPointTemplateId(scope);
      yield* stack.destroy();

      const foreign = yield* automation.createVolumeAutomation({
        ...scope,
        templateId,
        name: "alchemy-test-foreign-automation",
        input: { ...input, kind: "VolumeRecoveryPointManagement" },
      });
      yield* Effect.gen(function* () {
        const resource = Stackit.Automation.VolumeAutomation("Foreign", {
          templateId,
          name: "alchemy-test-foreign-automation",
          description: "Adopted",
          input,
        });
        const refused = yield* stack.deploy(resource).pipe(Effect.flip);
        expect(refused._tag).toEqual("OwnedBySomeoneElse");
        const untouched = yield* automation.getVolumeAutomation({
          ...scope,
          automationId: foreign.id,
        });
        expect(untouched.description ?? "").toEqual("");

        const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
        expect(adopted.automationId).toEqual(foreign.id);
        const changed = yield* automation.getVolumeAutomation({
          ...scope,
          automationId: foreign.id,
        });
        expect(changed.description).toEqual("Adopted");

        // The stack owns it now, so destroying it deletes it.
        yield* stack.destroy();
        yield* expectGone(scope, foreign.id);
      }).pipe(Effect.ensuring(deleteOutOfBand(scope, foreign.id).pipe(Effect.ignore)));
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the region creates the automation there and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const other = region === "eu01" ? "eu02" : "eu01";
      const templateId = yield* recoveryPointTemplateId({ projectId, region });
      const otherTemplateId = yield* recoveryPointTemplateId({ projectId, region: other });
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.Automation.VolumeAutomation("Moving", {
          templateId,
          name: "alchemy-test-moving-automation",
          region,
          input,
        }),
      );
      const moved = yield* stack.deploy(
        Stackit.Automation.VolumeAutomation("Moving", {
          templateId: otherTemplateId,
          name: "alchemy-test-moving-automation",
          region: other,
          input,
        }),
      );
      expect(moved.region).toEqual(other);
      expect(moved.automationId).not.toEqual(first.automationId);
      yield* expectGone({ projectId, region }, first.automationId);
      const fetched = yield* automation.getVolumeAutomation({
        projectId,
        region: other,
        automationId: moved.automationId,
      });
      expect(fetched.name).toEqual("alchemy-test-moving-automation");

      yield* stack.destroy();
      yield* expectGone({ projectId, region: other }, moved.automationId);
    }).pipe(logLevel),
  options,
);
