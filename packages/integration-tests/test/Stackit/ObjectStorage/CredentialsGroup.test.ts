import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("objectstorage", "credentialsgroup"),
  timeout: 180_000,
} as const;

/** Out-of-band: the group as STACKIT reports it, or `undefined` when gone. */
const observeGroup = (projectId: string, region: string, groupId: string) =>
  objectStorage.getCredentialsGroup({ projectId, region, groupId }).pipe(
    Effect.map((response) => response.credentialsGroup),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const waitUntilGroupGone = (projectId: string, region: string, groupId: string) =>
  observeGroup(projectId, region, groupId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (group) => group === undefined,
      times: 10,
    }),
  );

test.provider(
  "create, redeploy unchanged, and delete a credentials group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const group = yield* stack.deploy(Stackit.ObjectStorage.CredentialsGroup("Writers", {}));

      expect(group.projectId).toEqual(projectId);
      expect(group.region).toEqual(region);
      expect(group.credentialsGroupId).not.toEqual("");
      expect(group.displayName).not.toEqual("default");
      expect(group.urn).not.toEqual("");
      expect(group.userUrn).not.toEqual("");

      const observed = yield* observeGroup(projectId, region, group.credentialsGroupId);
      expect(observed?.displayName).toEqual(group.displayName);
      expect(observed?.urn).toEqual(group.urn);
      expect(observed?.userUrn).toEqual(group.userUrn);

      const plan = yield* stack.plan(Stackit.ObjectStorage.CredentialsGroup("Writers", {}));
      expect(plan.resources.Writers).toMatchObject({ action: "noop" });

      const provider = yield* Provider.findProvider(Stackit.ObjectStorage.CredentialsGroup);
      const listed = yield* provider.list();
      expect(listed.map((entry) => entry.credentialsGroupId)).toContain(group.credentialsGroupId);

      yield* stack.destroy();

      expect(
        yield* waitUntilGroupGone(projectId, region, group.credentialsGroupId),
      ).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the display name replaces the group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(Stackit.ObjectStorage.CredentialsGroup("Readers", {}));
      // Deterministic per stack/stage: derived from the generated name.
      const displayName = `${first.displayName.slice(0, 55)}-renamed`;

      const second = yield* stack.deploy(
        Stackit.ObjectStorage.CredentialsGroup("Readers", { displayName }),
      );
      expect(second.displayName).toEqual(displayName);
      expect(second.credentialsGroupId).not.toEqual(first.credentialsGroupId);
      expect(
        (yield* observeGroup(projectId, region, second.credentialsGroupId))?.displayName,
      ).toEqual(displayName);
      expect(
        yield* waitUntilGroupGone(projectId, region, first.credentialsGroupId),
      ).toBeUndefined();

      yield* stack.destroy();

      expect(
        yield* waitUntilGroupGone(projectId, region, second.credentialsGroupId),
      ).toBeUndefined();
    }).pipe(logLevel),
  options,
);
