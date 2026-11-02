import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as scf from "@distilled.cloud/stackit/scf";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, expectGone, scfScope } from "./helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("cloudfoundry", "space"), timeout: 1_500_000 } as const;

test.provider(
  "create, rename, move and delete a space",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (name: string | undefined, holder: "First" | "Second") =>
        Effect.gen(function* () {
          const first = yield* Stackit.CloudFoundry.Organization("First", {});
          const second = yield* Stackit.CloudFoundry.Organization("Second", {});
          const space = yield* Stackit.CloudFoundry.Space("Space", {
            organizationId: (holder === "First" ? first : second).organizationId,
            name,
            forceDestroy: true,
          });
          return { first, second, space };
        });

      const created = yield* stack.deploy(program(undefined, "First"));
      const firstOrg = created.first.organizationId;
      expect(created.space.organizationId).toEqual(firstOrg);
      expect(created.space.apiUrl).toMatch(/^https:\/\//);
      const observed = yield* scf.getSpace({
        ...scope,
        organizationId: firstOrg,
        spaceId: created.space.spaceId,
      });
      expect(observed.name).toEqual(created.space.name);

      const unchanged = yield* stack.plan(program(undefined, "First"));
      expect(unchanged.resources.Space).toMatchObject({ action: "noop" });

      const renamed = yield* stack.deploy(program("alchemy-test-cf-space", "First"));
      expect(renamed.space.spaceId).toEqual(created.space.spaceId);
      const afterRename = yield* scf.getSpace({
        ...scope,
        organizationId: firstOrg,
        spaceId: created.space.spaceId,
      });
      expect(afterRename.name).toEqual("alchemy-test-cf-space");

      // Moving it replaces it, and the old one goes.
      const moved = yield* stack.deploy(program("alchemy-test-cf-space", "Second"));
      expect(moved.space.spaceId).not.toEqual(created.space.spaceId);
      expect(moved.space.organizationId).toEqual(moved.second.organizationId);
      yield* expectGone(
        scf.getSpace({ ...scope, organizationId: firstOrg, spaceId: created.space.spaceId }),
      );

      yield* stack.destroy();
      yield* expectGone(
        scf.getSpace({
          ...scope,
          organizationId: moved.second.organizationId,
          spaceId: moved.space.spaceId,
        }),
      );
    }).pipe(logLevel),
  options,
);

test.provider(
  "with no credentials, a delete and a replacement stop until forceDestroy is deployed",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (holder: "First" | "Second", forceDestroy?: boolean) =>
        Effect.gen(function* () {
          const first = yield* Stackit.CloudFoundry.Organization("GuardedFirst", {});
          const second = yield* Stackit.CloudFoundry.Organization("GuardedSecond", {});
          const space = yield* Stackit.CloudFoundry.Space("GuardedSpace", {
            organizationId: (holder === "First" ? first : second).organizationId,
            ...(forceDestroy !== undefined ? { forceDestroy } : {}),
          });
          return { first, second, space };
        });

      const created = yield* stack.deploy(program("First"));
      const space = {
        ...scope,
        organizationId: created.first.organizationId,
        spaceId: created.space.spaceId,
      };

      const refusal = {
        _tag: "Stackit.CloudFoundry.SpaceDeleteRefused",
        spaceId: created.space.spaceId,
        reason: "no-credentials",
      };
      // The plan fails, so nothing is created that a refused delete would strand.
      expect(yield* stack.deploy(program("Second")).pipe(Effect.flip)).toMatchObject(refusal);
      expect(yield* stack.destroy().pipe(Effect.flip)).toMatchObject(refusal);
      expect((yield* scf.getSpace(space)).guid).toEqual(created.space.spaceId);

      // An opt-in set in the same deploy as the move isn't enough: the old space's delete sees
      // what it was deployed with.
      expect(yield* stack.deploy(program("Second", true)).pipe(Effect.flip)).toMatchObject(refusal);

      yield* stack.deploy(program("First", true));
      const moved = yield* stack.deploy(program("Second", true));
      expect(moved.space.spaceId).not.toEqual(created.space.spaceId);
      yield* expectGone(scf.getSpace(space));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "with credentials, an empty space deletes, and an app someone pushed stops the delete",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (forceDestroy?: boolean) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("CheckedOrg", {});
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("CheckedManager", {
            organizationId: organization.organizationId,
          });
          const credentials = {
            apiUrl: manager.apiUrl,
            username: manager.username,
            password: manager.password,
          };
          const space = yield* Stackit.CloudFoundry.Space("CheckedSpace", {
            organizationId: organization.organizationId,
            credentials,
            ...(forceDestroy !== undefined ? { forceDestroy } : {}),
          });
          yield* Stackit.CloudFoundry.SpaceRole("CheckedDeveloper", {
            organizationId: organization.organizationId,
            spaceId: space.spaceId,
            type: "space_developer",
            userGuid: manager.userId,
            credentials,
          });
          return { organization, manager, space };
        });

      const created = yield* stack.deploy(program());
      const app = yield* cf
        .createApp({
          name: "alchemy-test-cf-foreign-app",
          relationships: { space: { data: { guid: created.space.spaceId } } },
        })
        .pipe(asManager(created.manager));

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.CloudFoundry.SpaceDeleteRefused",
        reason: "not-empty",
        apps: ["alchemy-test-cf-foreign-app"],
      });
      const survivor = yield* scf.getSpace({
        ...scope,
        organizationId: created.organization.organizationId,
        spaceId: created.space.spaceId,
      });
      expect(survivor.guid).toEqual(created.space.spaceId);
      expect(app.guid).toBeDefined();

      // The destroy above got as far as the role, so this restores it, and opts in.
      yield* stack.deploy(program(true));
      yield* stack.destroy();
      yield* expectGone(
        scf.getOrganization({
          ...scope,
          organizationId: created.organization.organizationId,
        }),
      );
    }).pipe(logLevel),
  options,
);
