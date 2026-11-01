import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as scf from "@distilled.cloud/stackit/scf";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { expectGone, foreignOrganization, scfScope } from "./helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("cloudfoundry", "organization"), timeout: 1_500_000 } as const;

test.provider(
  "create, update, redeploy and delete an organization",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.CloudFoundry.Organization("Basic", {}));
      expect(created.organizationId).toEqual(expect.any(String));
      expect(created.apiUrl).toMatch(/^https:\/\//);
      expect(created.suspended).toEqual(false);

      // Out of band: the name and the platform it landed on.
      const observed = yield* scf.getOrganization({
        ...scope,
        organizationId: created.organizationId,
      });
      expect(observed.name).toEqual(created.name);
      expect(observed.platformId).toEqual(created.platformId);

      const unchanged = yield* stack.plan(Stackit.CloudFoundry.Organization("Basic", {}));
      expect(unchanged.resources.Basic).toMatchObject({ action: "noop" });

      const renamed = yield* stack.deploy(
        Stackit.CloudFoundry.Organization("Basic", { name: "alchemy-test-cf-basic-renamed" }),
      );
      expect(renamed.organizationId).toEqual(created.organizationId);
      const afterRename = yield* scf.getOrganization({
        ...scope,
        organizationId: created.organizationId,
      });
      expect(afterRename.name).toEqual("alchemy-test-cf-basic-renamed");

      const quotas = yield* scf.listPlatformQuotas({ ...scope, platformId: created.platformId });
      const other = quotas.find((quota) => quota.guid !== afterRename.quotaId);
      if (other !== undefined) {
        const requoted = yield* stack.deploy(
          Stackit.CloudFoundry.Organization("Basic", {
            name: "alchemy-test-cf-basic-renamed",
            quotaId: other.guid,
          }),
        );
        expect(requoted.quotaId).toEqual(other.guid);
      }

      yield* stack.destroy();
      yield* expectGone(scf.getOrganization({ ...scope, organizationId: created.organizationId }));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a foreign organization at an explicit name is refused",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();
      const organizationId = yield* foreignOrganization("alchemy-test-cf-foreign");

      const error = yield* stack
        .deploy(Stackit.CloudFoundry.Organization("Foreign", { name: "alchemy-test-cf-foreign" }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse" });

      // Untouched.
      const survivor = yield* scf.getOrganization({ ...scope, organizationId });
      expect(survivor.name).toEqual("alchemy-test-cf-foreign");

      yield* scf.deleteOrganization({ ...scope, organizationId });
      yield* expectGone(scf.getOrganization({ ...scope, organizationId }));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a space this stack doesn't manage stops the delete, until it is gone",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* scfScope;
      yield* stack.destroy();
      const organization = yield* stack.deploy(Stackit.CloudFoundry.Organization("Holder", {}));
      const { organizationId } = organization;
      const foreign = yield* scf.createSpace({
        ...scope,
        organizationId,
        name: "alchemy-test-cf-foreign-space",
      });

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.CloudFoundry.OrganizationNotEmpty",
        spaces: ["alchemy-test-cf-foreign-space"],
      });
      const survivor = yield* scf.getSpace({ ...scope, organizationId, spaceId: foreign.guid });
      expect(survivor.name).toEqual("alchemy-test-cf-foreign-space");

      yield* scf.deleteSpace({ ...scope, organizationId, spaceId: foreign.guid });
      yield* expectGone(scf.getSpace({ ...scope, organizationId, spaceId: foreign.guid }));
      yield* stack.destroy();
      yield* expectGone(scf.getOrganization({ ...scope, organizationId }));
    }).pipe(logLevel),
  options,
);
