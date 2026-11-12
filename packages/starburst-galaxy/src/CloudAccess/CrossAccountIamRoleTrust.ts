import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { lookupOnlyLifecycle } from "../LookupOnly.ts";
import type { Providers } from "../Providers.ts";

/** The trust facts take no key: there is one set per Galaxy account. */
export type CrossAccountIamRoleTrustLookup = {};

export interface CrossAccountIamRoleTrustAttributes {
  /** The external ID an IAM role's trust policy must require (`sts:ExternalId`). */
  readonly externalId: string;
  /** Starburst's AWS account ID, the principal the trust policy names. */
  readonly starburstAwsAccountId: string;
}

export type CrossAccountIamRoleTrust = Resource<
  "StarburstGalaxy.CrossAccountIamRoleTrust",
  CrossAccountIamRoleTrustLookup,
  CrossAccountIamRoleTrustAttributes,
  never,
  Providers,
  CrossAccountIamRoleTrustLookup
>;

/**
 * What an AWS IAM role's trust policy must say for Starburst Galaxy to
 * assume it: Starburst's AWS account and this Galaxy account's external
 * ID. Read it before creating the role, then register the role with
 * `StarburstGalaxy.CrossAccountIamRole`.
 *
 * It is account-level information, only looked up. Declaring
 * `StarburstGalaxy.CrossAccountIamRoleTrust(...)` in a stack fails with
 * `StarburstGalaxy.LookupOnlyResource`.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-cluster-connectivity/aws/external-aws.html
 *
 * ### Writing the trust policy
 * **Example:** An IAM role Galaxy can assume, registered with Galaxy
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
 * yield* StarburstGalaxy.CrossAccountIamRole("GalaxyLake", { roleArn: role.roleArn });
 * ```
 *
 * @resource
 * @product Cloud access
 */
export const CrossAccountIamRoleTrust = Resource<CrossAccountIamRoleTrust>(
  "StarburstGalaxy.CrossAccountIamRoleTrust",
);

export const CrossAccountIamRoleTrustProvider = () =>
  Provider.succeed(CrossAccountIamRoleTrust, {
    ...lookupOnlyLifecycle(
      "StarburstGalaxy.CrossAccountIamRoleTrust",
      "the trust facts are account-level settings Galaxy only reports",
    ),
    lookup: Effect.fn(function* () {
      const metadata = yield* galaxy.crossAccountIamRole.getCrossAccountIamRoleMetadata({});
      return {
        externalId: metadata.externalId,
        starburstAwsAccountId: metadata.starburstAwsAccountId,
      };
    }),
  });
