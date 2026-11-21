import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Usergroups from "@distilled.cloud/slack/usergroups";
import * as Effect from "effect/Effect";
import { aHuman } from "./helpers.ts";

const { test } = Test.make({ providers: Slack.providers() });

const find = (id: string) =>
  Usergroups.listUsergroups({ include_disabled: true, include_users: true }).pipe(
    Effect.map((r) => r.usergroups.find((g) => g.id === id)),
  );

test.provider(
  "create, update name, description, channels and members, disable on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const handle = `alchemy-${stack.stage}`.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "-");
      const user = yield* aHuman;

      const created = yield* stack.deploy(
        Slack.UserGroup("OnCall", { name: `On-call ${stack.stage}`, handle, description: "first" }),
      );
      expect(created.userGroupId).toMatch(/^S/);
      let observed = yield* find(created.userGroupId);
      expect(observed?.handle).toBe(handle);
      expect(observed?.description).toBe("first");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* Slack.Channel("Default", {});
          return yield* Slack.UserGroup("OnCall", {
            name: `On-call ${stack.stage} (updated)`,
            handle,
            description: "second",
            channels: [channel.channelId],
            users: [user],
          });
        }),
      );
      expect(updated.userGroupId).toBe(created.userGroupId);
      observed = yield* find(created.userGroupId);
      expect(observed?.name).toBe(`On-call ${stack.stage} (updated)`);
      expect(observed?.description).toBe("second");
      expect(observed?.prefs?.channels).toHaveLength(1);
      expect(observed?.users).toEqual([user]);

      yield* stack.destroy();
      expect((yield* find(created.userGroupId))?.date_delete ?? 0).toBeGreaterThan(0);

      // The handle is still held by the disabled group: deploying again
      // re-enables it instead of failing.
      const again = yield* stack.deploy(
        Slack.UserGroup("OnCall", { name: `On-call ${stack.stage}`, handle }),
      );
      expect(again.userGroupId).toBe(created.userGroupId);
      expect((yield* find(created.userGroupId))?.date_delete ?? 0).toBe(0);
      yield* stack.destroy();
    }),
  { tags: ["provider:slack", "provider:slack:user-group", "live"], timeout: 120_000 },
);
