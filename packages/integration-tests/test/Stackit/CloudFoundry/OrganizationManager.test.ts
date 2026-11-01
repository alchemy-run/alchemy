import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as scf from "@distilled.cloud/stackit/scf";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, expectGone, scfScope } from "./helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("cloudfoundry", "organizationmanager"),
  timeout: 1_500_000,
} as const;

test.provider(
  "create, log in, rotate and delete a manager",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (rotationKey: string | undefined) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("ManagerOrg", {});
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
            organizationId: organization.organizationId,
            rotationKey,
          });
          return { organization, manager };
        });

      const created = yield* stack.deploy(program(undefined));
      const organizationId = created.organization.organizationId;
      expect(Redacted.isRedacted(created.manager.password)).toBe(true);
      expect(created.manager.apiUrl).toEqual(created.organization.apiUrl);

      // Out of band: the same user, and its password logs in to the Cloud Foundry API.
      const observed = yield* scf.getOrgManager({ ...scope, organizationId });
      expect(observed.guid).toEqual(created.manager.userId);
      expect(observed.username).toEqual(created.manager.username);
      const domains = yield* cf.listDomains({ per_page: 1 }).pipe(asManager(created.manager));
      expect(domains.resources?.length).toEqual(1);

      const unchanged = yield* stack.plan(program(undefined));
      expect(unchanged.resources.Manager).toMatchObject({ action: "noop" });

      // Rotating recreates it: there is no reset, and one per organization.
      const rotated = yield* stack.deploy(program("2026-11"));
      expect(rotated.manager.userId).not.toEqual(created.manager.userId);
      expect(rotated.manager.rotationKey).toEqual("2026-11");
      expect(Redacted.value(rotated.manager.password!)).not.toEqual(
        Redacted.value(created.manager.password!),
      );
      const afterRotation = yield* scf.getOrgManager({ ...scope, organizationId });
      expect(afterRotation.guid).toEqual(rotated.manager.userId);

      yield* stack.destroy();
      yield* expectGone(scf.getOrganization({ ...scope, organizationId }));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a manager found without state is refused, and destroying twice is idempotent",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();
      const organization = yield* stack.deploy(
        Stackit.CloudFoundry.Organization("ForeignManagerOrg", {}),
      );
      const { organizationId } = organization;
      const foreign = yield* scf.createOrgManager({ ...scope, organizationId });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Stackit.CloudFoundry.Organization("ForeignManagerOrg", {});
            return yield* Stackit.CloudFoundry.OrganizationManager("ForeignManager", {
              organizationId,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      const survivor = yield* scf.getOrgManager({ ...scope, organizationId });
      expect(survivor.guid).toEqual(foreign.guid);

      // The API answers 410 for a manager that is already gone.
      yield* scf.deleteOrgManager({ ...scope, organizationId });
      const second = yield* scf.deleteOrgManager({ ...scope, organizationId }).pipe(
        Effect.as("deleted" as const),
        Effect.catchTag(["NotFound", "OrgManagerGone"], (e) => Effect.succeed(e._tag)),
      );
      expect(second).toEqual("OrgManagerGone");

      yield* stack.destroy();
      yield* expectGone(scf.getOrganization({ ...scope, organizationId }));
    }).pipe(logLevel),
  options,
);

test.provider(
  "rotating the manager replaces a role it holds, and the old role doesn't stop the deploy",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (rotationKey: string | undefined) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("RotatedOrg", {});
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("RotatedManager", {
            organizationId: organization.organizationId,
            rotationKey,
          });
          const credentials = {
            apiUrl: manager.apiUrl,
            username: manager.username,
            password: manager.password,
          };
          const space = yield* Stackit.CloudFoundry.Space("RotatedSpace", {
            organizationId: organization.organizationId,
            credentials,
          });
          const role = yield* Stackit.CloudFoundry.SpaceRole("RotatedRole", {
            organizationId: organization.organizationId,
            spaceId: space.spaceId,
            type: "space_developer",
            userGuid: manager.userId,
            credentials,
          });
          return { organization, manager, space, role };
        });

      const created = yield* stack.deploy(program(undefined));
      expect(created.role.heldByLogin).toBe(true);

      // Twice, because a failed old generation would fail every later deploy.
      const rotated = yield* stack.deploy(program("2026-11"));
      expect(rotated.manager.userId).not.toEqual(created.manager.userId);
      expect(rotated.role.roleId).not.toEqual(created.role.roleId);
      expect(rotated.role.userGuid).toEqual(rotated.manager.userId);
      const again = yield* stack.deploy(program("2026-12"));
      expect(again.role.userGuid).toEqual(again.manager.userId);

      // The new login holds the new role.
      const role = yield* cf.getRole({ guid: again.role.roleId }).pipe(asManager(again.manager));
      expect(role.type).toEqual("space_developer");

      yield* stack.destroy();
      yield* expectGone(
        scf.getOrganization({ ...scope, organizationId: again.organization.organizationId }),
      );
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new rotationKey replaces a manager someone recreated by hand",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const program = (rotationKey: string | undefined) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("HandMadeOrg", {});
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("HandMadeManager", {
            organizationId: organization.organizationId,
            rotationKey,
          });
          return { organization, manager };
        });

      const created = yield* stack.deploy(program("one"));
      const organizationId = created.organization.organizationId;
      yield* scf.deleteOrgManager({ ...scope, organizationId });
      const handMade = yield* scf.createOrgManager({ ...scope, organizationId });

      // A new key is the opt-in: it replaces the manager this stack didn't make.
      const rotated = yield* stack.deploy(program("two"));
      expect(rotated.manager.userId).not.toEqual(handMade.guid);

      yield* stack.destroy();
      yield* expectGone(scf.getOrganization({ ...scope, organizationId }));
    }).pipe(logLevel),
  options,
);
