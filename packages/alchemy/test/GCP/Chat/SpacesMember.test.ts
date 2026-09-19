import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as chat from "@distilled.cloud/gcp/chat_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  chatMember,
  hasGcpCreds,
  logLevel,
  runMemberLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  chat.getSpacesMembers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getSpacesMembers on a missing membership fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.getSpacesMembers({
          name: "spaces/alchemy-missing/members/users/me",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CHAT)(
  "createSpacesMembers without Chat access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.createSpacesMembers({
          parent: "spaces/alchemy-missing",
          body: { member: { name: "users/me", type: "HUMAN" } },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runMemberLifecycle)(
  "create, update, and delete a space membership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const space = yield* GCP.Chat.Space("MemberSpace", {
            displayName: "Memberships",
            spaceType: "SPACE",
          });
          const member = yield* GCP.Chat.SpacesMember("Guest", {
            parent: space.name,
            memberName: chatMember!,
            role: "ROLE_MEMBER",
          });
          return { space, member };
        }),
      );

      expect(created.member.parent).toEqual(created.space.name);
      expect(created.member.name).toContain("/members/");

      const fetched = yield* chat.getSpacesMembers({
        name: created.member.name,
      });
      expect(fetched.name).toEqual(created.member.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const space = yield* GCP.Chat.Space("MemberSpace", {
            spaceId: created.space.spaceId,
            displayName: "Memberships",
            spaceType: "SPACE",
          });
          const member = yield* GCP.Chat.SpacesMember("Guest", {
            parent: space.name,
            membershipName: created.member.name,
            memberName: chatMember!,
            role: "ROLE_MANAGER",
          });
          return { space, member };
        }),
      );

      expect(updated.member.name).toEqual(created.member.name);
      expect(updated.member.role).toEqual("ROLE_MANAGER");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.member.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
