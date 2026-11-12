import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { CrossAccountIamRole as CrossAccountIamRoleShape } from "@distilled.cloud/starburst-galaxy/cross_account_iam_role";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { collectAll, findFirst, GOVERNANCE_NAME, ownership, physicalName } from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface CrossAccountIamRoleProps {
  /**
   * ARN of the AWS IAM role Galaxy assumes. Its trust policy must name
   * Starburst's AWS account and require Galaxy's external ID (see
   * `StarburstGalaxy.CrossAccountIamRoleTrust`): Galaxy assumes the role
   * when it is registered. Changing it replaces the registration.
   */
  readonly roleArn: string;
  /**
   * Name Galaxy shows for the role. Changing it replaces the registration.
   * @default generated from the stack, logical id and stage
   */
  readonly aliasName?: string;
}

export interface CrossAccountIamRoleAttributes {
  /** ARN of the registered role: pass it as a catalog's `roleArn`. */
  readonly roleArn: string;
  /** Name Galaxy shows for the role. */
  readonly aliasName: string;
  /** IDs of the catalogs and ingest sources that use the role. */
  readonly dependants: ReadonlyArray<string>;
}

export type CrossAccountIamRole = Resource<
  "StarburstGalaxy.CrossAccountIamRole",
  CrossAccountIamRoleProps,
  CrossAccountIamRoleAttributes,
  never,
  Providers
>;

/** Galaxy accepted a registration but the role could not be read back. */
export class CrossAccountIamRoleNotResolved extends Data.TaggedError(
  "StarburstGalaxy.CrossAccountIamRoleNotResolved",
)<{ readonly roleArn: string }> {
  override get message() {
    return `Cross-account IAM role ${this.roleArn} could not be found after it was registered`;
  }
}

/**
 * An AWS IAM role registered with Starburst Galaxy, so S3, Redshift and
 * OpenSearch catalogs and ingest sources can reach your AWS account by
 * assuming it instead of holding access keys.
 *
 * Galaxy has no update operation: both props replace the registration.
 * Galaxy assumes the role when it is registered and refuses a role whose
 * trust policy does not let it (`Unable to assume role from any Galaxy
 * cluster`); IAM changes take a few seconds to propagate, so create the
 * role in the same stack and pass its ARN through.
 *
 * Registrations have no labels or tags in Galaxy: one Alchemy created is
 * recognized by its generated alias.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-cluster-connectivity/aws/external-aws.html
 *
 * ### Registering a role
 * **Example:** A role trusted by Galaxy, used by an S3 catalog
 * ```typescript
 * const trust = StarburstGalaxy.CrossAccountIamRoleTrust.lookup({});
 * const role = yield* AWS.IAM.Role("GalaxyLake", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: Output.interpolate`arn:aws:iam::${trust.starburstAwsAccountId}:root` },
 *         Action: "sts:AssumeRole",
 *         Condition: { StringEquals: { "sts:ExternalId": trust.externalId } },
 *       },
 *     ],
 *   },
 * });
 * const registered = yield* StarburstGalaxy.CrossAccountIamRole("GalaxyLake", {
 *   roleArn: role.roleArn,
 * });
 * yield* StarburstGalaxy.S3Catalog("Lake", {
 *   roleArn: registered.roleArn,
 *   metastore: { type: "galaxy", defaultBucket: "analytics-lake", defaultDataLocation: "warehouse" },
 * });
 * ```
 *
 * @resource
 * @product Cloud access
 */
export const CrossAccountIamRole = Resource<CrossAccountIamRole>(
  "StarburstGalaxy.CrossAccountIamRole",
);

const toAttributes = (role: CrossAccountIamRoleShape): CrossAccountIamRoleAttributes => ({
  roleArn: role.awsIamArn,
  aliasName: role.aliasName,
  dependants: role.dependants,
});

/** Galaxy has no get operation: registrations are found on the list. */
const findByArn = (roleArn: string) =>
  findFirst(
    galaxy.crossAccountIamRole.listCrossAccountIamRoles.items({}),
    (role) => role.awsIamArn === roleArn,
  );

export const CrossAccountIamRoleProvider = () =>
  Provider.succeed(CrossAccountIamRole, {
    stables: ["roleArn", "aliasName"],

    nuke: {
      // Catalogs that assume the role are deleted first.
      dependsOn: [
        "StarburstGalaxy.S3Catalog",
        "StarburstGalaxy.RedshiftCatalog",
        "StarburstGalaxy.OpenSearchCatalog",
      ],
    },

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const alias = output?.aliasName ?? (yield* physicalName(id, olds.aliasName, GOVERNANCE_NAME));
      const nextAlias = yield* physicalName(id, news.aliasName, GOVERNANCE_NAME);
      if (news.roleArn !== olds.roleArn || nextAlias !== alias) {
        // Galaxy registers an ARN once: a replacement keeping it frees it first.
        return { action: "replace", deleteFirst: news.roleArn === olds.roleArn } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const role = yield* findByArn(output?.roleArn ?? olds.roleArn);
      if (role === undefined) return undefined;
      const alias = yield* physicalName(id, olds?.aliasName, GOVERNANCE_NAME);
      if (output === undefined && role.aliasName !== alias) {
        // Registered under another alias: someone else's registration.
        return ownership(toAttributes(role), {
          output,
          explicitName: role.aliasName,
          previous,
          key: "roleArn",
        });
      }
      return toAttributes(role);
    }),

    reconcile: Effect.fn(function* ({ id, news, session }) {
      const aliasName = yield* physicalName(id, news.aliasName, GOVERNANCE_NAME);
      const existing = yield* findByArn(news.roleArn);
      if (existing !== undefined) return toAttributes(existing);
      yield* session.note(`Registering IAM role ${news.roleArn}...`);
      const created = yield* galaxy.crossAccountIamRole
        .createCrossAccountIamRole({ awsIamArn: news.roleArn, aliasName })
        .pipe(Effect.catchTag("Conflict", () => findByArn(news.roleArn)));
      if (created === undefined) {
        return yield* new CrossAccountIamRoleNotResolved({ roleArn: news.roleArn });
      }
      return toAttributes(created);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.crossAccountIamRole
        .deleteCrossAccountIamRole({ crossAccountIamRoleId: output.roleArn })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(galaxy.crossAccountIamRole.listCrossAccountIamRoles.items({}), toAttributes),
  });
