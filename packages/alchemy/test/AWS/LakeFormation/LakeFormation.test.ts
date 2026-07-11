import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as iam from "@distilled.cloud/aws/iam";
import * as lf from "@distilled.cloud/aws/lakeformation";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * LF-tag operations and permission grants require the caller to be a data
 * lake administrator. Each stack bootstraps the caller as admin via
 * `DataLakeSettings` (managed additively + restored on destroy). Derive the
 * caller's IAM role ARN (with path — `GetRole` returns it, the assumed-role
 * STS ARN does not carry the path).
 */
const callerPrincipalArn = Effect.gen(function* () {
  const identity = yield* sts.getCallerIdentity({});
  const arn = identity.Arn!;
  const match = /assumed-role\/([^/]+)\//.exec(arn);
  if (match === null) return arn;
  const role = yield* iam.getRole({ RoleName: match[1]! });
  return role.Role.Arn;
});

const adminIds = Effect.gen(function* () {
  const settings = (yield* lf.getDataLakeSettings({})).DataLakeSettings ?? {};
  return (settings.DataLakeAdmins ?? [])
    .map((p) => p.DataLakePrincipalIdentifier)
    .filter((id): id is string => id !== undefined);
});

/** Raw (unfiltered) permission entries a principal holds on a database. */
const principalDatabasePermissions = (
  principal: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const pages = yield* lf.listPermissions
      .pages({ Resource: { Database: { Name: databaseName } } })
      .pipe(Stream.runCollect);
    return Array.from(pages)
      .flatMap((p) => p.PrincipalResourcePermissions ?? [])
      .filter((e) => e.Principal?.DataLakePrincipalIdentifier === principal)
      .flatMap((e) => e.Permissions ?? [])
      .sort();
  });

const trustPolicy: AWS.IAM.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "glue.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// All three tests mutate the account-level DataLakeSettings singleton
// (adding the caller / a scratch role as admin) — run them sequentially so
// concurrent read-modify-write cycles cannot clobber each other.
describe.sequential("LakeFormation", () => {
  test.provider(
    "DataLakeSettings adds admins additively and restores on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const beforeAdmins = yield* adminIds;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const role = yield* AWS.IAM.Role("LfAdminRole", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Settings",
              { dataLakeAdmins: [role.roleArn] },
            );
            return { role, settings };
          }),
        );

        expect(created.settings.catalogId).toBeDefined();
        expect(created.settings.dataLakeAdmins).toContain(created.role.roleArn);
        expect(created.settings.managedAdmins).toEqual([created.role.roleArn]);

        // out-of-band: our admin was added, pre-existing admins survived
        const duringAdmins = yield* adminIds;
        expect(duringAdmins).toContain(created.role.roleArn);
        for (const admin of beforeAdmins) {
          expect(duringAdmins).toContain(admin);
        }

        // destroy — only the admin we added is removed
        yield* stack.destroy();
        const afterAdmins = yield* adminIds;
        expect(afterAdmins).not.toContain(created.role.roleArn);
        for (const admin of beforeAdmins) {
          expect(afterAdmins).toContain(admin);
        }
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "Permissions grants, updates, and revokes on a Glue database",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const admin = yield* callerPrincipalArn;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const grant = yield* AWS.LakeFormation.Permissions("AnalystDb", {
              // consume a settings output so admin bootstrap deploys first
              // and is destroyed last
              catalogId: settings.catalogId,
              principal: role.roleArn,
              resource: { database: { name: database.databaseName } },
              permissions: ["CREATE_TABLE", "DESCRIBE"],
            });
            return { settings, database, role, grant };
          }),
        );

        expect(created.grant.permissions).toEqual(["CREATE_TABLE", "DESCRIBE"]);
        expect(created.grant.resource.Database?.Name).toEqual(
          created.database.databaseName,
        );

        // out-of-band verification (raw entries, not principal-filtered)
        const observed = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(observed).toEqual(["CREATE_TABLE", "DESCRIBE"]);

        // update — swap CREATE_TABLE for ALTER (grant + revoke delta)
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            const grant = yield* AWS.LakeFormation.Permissions("AnalystDb", {
              catalogId: settings.catalogId,
              principal: role.roleArn,
              resource: { database: { name: database.databaseName } },
              permissions: ["ALTER", "DESCRIBE"],
            });
            return { settings, database, role, grant };
          }),
        );

        expect(updated.grant.permissions).toEqual(["ALTER", "DESCRIBE"]);
        const reobserved = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(reobserved).toEqual(["ALTER", "DESCRIBE"]);

        // remove the grant from the stack — permissions are revoked while
        // the database still exists, so we can verify out-of-band
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const database = yield* AWS.Glue.Database("LfDb", {});
            const role = yield* AWS.IAM.Role("LfAnalyst", {
              assumeRolePolicyDocument: trustPolicy,
            });
            return { settings, database, role };
          }),
        );

        const revoked = yield* principalDatabasePermissions(
          created.role.roleArn,
          created.database.databaseName,
        );
        expect(revoked).toEqual([]);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "LFTag lifecycle and LFTagAssociation on a Glue database",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const admin = yield* callerPrincipalArn;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const tag = yield* AWS.LakeFormation.LFTag("EnvTag", {
              catalogId: settings.catalogId,
              tagKey: "alchemy-lf-env",
              tagValues: ["dev", "prod"],
            });
            const database = yield* AWS.Glue.Database("LfTagDb", {});
            const association = yield* AWS.LakeFormation.LFTagAssociation(
              "DbEnv",
              {
                catalogId: settings.catalogId,
                resource: { database: { name: database.databaseName } },
                lfTags: [{ tagKey: tag.tagKey, tagValues: ["dev"] }],
              },
            );
            return { settings, tag, database, association };
          }),
        );

        expect(created.tag.tagKey).toEqual("alchemy-lf-env");
        expect([...created.tag.tagValues].sort()).toEqual(["dev", "prod"]);

        // out-of-band: tag definition + assignment on the database
        const observedTag = yield* lf.getLFTag({ TagKey: "alchemy-lf-env" });
        expect([...(observedTag.TagValues ?? [])].sort()).toEqual([
          "dev",
          "prod",
        ]);
        const observedAssignment = yield* lf.getResourceLFTags({
          Resource: {
            Database: { Name: created.database.databaseName },
          },
        });
        expect(
          observedAssignment.LFTagOnDatabase?.find(
            (t) => t.TagKey === "alchemy-lf-env",
          )?.TagValues,
        ).toEqual(["dev"]);

        // update — add a tag value and move the assignment onto it
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            const tag = yield* AWS.LakeFormation.LFTag("EnvTag", {
              catalogId: settings.catalogId,
              tagKey: "alchemy-lf-env",
              tagValues: ["dev", "prod", "staging"],
            });
            const database = yield* AWS.Glue.Database("LfTagDb", {});
            const association = yield* AWS.LakeFormation.LFTagAssociation(
              "DbEnv",
              {
                catalogId: settings.catalogId,
                resource: { database: { name: database.databaseName } },
                lfTags: [{ tagKey: tag.tagKey, tagValues: ["staging"] }],
              },
            );
            return { settings, tag, database, association };
          }),
        );

        const updatedTag = yield* lf.getLFTag({ TagKey: "alchemy-lf-env" });
        expect([...(updatedTag.TagValues ?? [])].sort()).toEqual([
          "dev",
          "prod",
          "staging",
        ]);
        const updatedAssignment = yield* lf.getResourceLFTags({
          Resource: {
            Database: { Name: created.database.databaseName },
          },
        });
        expect(
          updatedAssignment.LFTagOnDatabase?.find(
            (t) => t.TagKey === "alchemy-lf-env",
          )?.TagValues,
        ).toEqual(["staging"]);

        // remove tag + association from the stack (settings stay, so the
        // caller is still admin and can verify the deletion out-of-band —
        // GetLFTag as a non-admin is AccessDenied, not EntityNotFound)
        yield* stack.deploy(
          Effect.gen(function* () {
            const settings = yield* AWS.LakeFormation.DataLakeSettings(
              "Admin",
              { dataLakeAdmins: [admin] },
            );
            return { settings };
          }),
        );
        const goneTag = yield* lf
          .getLFTag({ TagKey: "alchemy-lf-env" })
          .pipe(
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        expect(goneTag).toBeUndefined();

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
