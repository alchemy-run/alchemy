import * as Lambda from "@distilled.cloud/aws/lambda";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { normalizePolicyDocument, type PolicyDocument } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface ResourcePolicyProps {
  /**
   * The ARN of the Lambda resource the policy is attached to: a
   * customer-managed runtime, an event function (qualified or not), or a
   * web function. Changing it replaces the policy.
   */
  resourceArn: string;
  /**
   * The resource-based policy, as a document or its JSON. It replaces any
   * policy already on the resource.
   */
  policyDocument: PolicyDocument | string;
}

export interface ResourcePolicy extends Resource<
  "AWS.Lambda.ResourcePolicy",
  ResourcePolicyProps,
  {
    /** The ARN of the resource the policy is attached to. */
    resourceArn: string;
    /** The policy's revision ID, which changes on every update. */
    revisionId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A resource-based policy on a Lambda resource, like CloudFormation's
 * `AWS::Lambda::ResourcePolicy`. Lambda keeps one policy per resource, and
 * every put replaces it whole, so manage each resource's policy with one
 * `ResourcePolicy`. Don't mix it with `AWS.Lambda.Permission` on the same
 * function: each overwrites the other's statements.
 *
 * ### Sharing a customer-managed runtime
 * A runtime is shared through the policy on the runtime itself. Each
 * statement's `Resource` names the aliases and versions a principal may
 * use. In another account, the consumer's IAM role also needs
 * `lambda:AssociateRuntimeAlias` on the alias.
 *
 * **Example:** Let every account in an organization use the runtime
 * ```typescript
 * const runtime = yield* AWS.Lambda.Runtime("Node", {});
 * yield* AWS.Lambda.ResourcePolicy("NodeSharing", {
 *   resourceArn: runtime.runtimeArn,
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "AllowOrganizationToUseRuntime",
 *         Effect: "Allow",
 *         Principal: "*",
 *         Action: ["lambda:AssociateRuntimeAlias", "lambda:AssociateRuntimeVersion"],
 *         Resource: [
 *           Output.interpolate`${runtime.runtimeArn}/alias/*`,
 *           Output.interpolate`${runtime.runtimeArn}/version/*`,
 *         ],
 *         Condition: { StringEquals: { "aws:PrincipalOrgID": "o-a1b2c3d4e5" } },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Share only the `prod` alias with another account
 * ```typescript
 * yield* AWS.Lambda.ResourcePolicy("NodeSharing", {
 *   resourceArn: runtime.runtimeArn,
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "AllowProdAliasOnly",
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: ["lambda:AssociateRuntimeAlias"],
 *         Resource: Output.interpolate`${runtime.runtimeArn}/alias/prod`,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Granting access to a function
 * **Example:** Let another account invoke a function
 * ```typescript
 * yield* AWS.Lambda.ResourcePolicy("ApiPolicy", {
 *   resourceArn: fn.functionArn,
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: ["lambda:InvokeFunction"],
 *         Resource: fn.functionArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ResourcePolicy = Resource<ResourcePolicy>("AWS.Lambda.ResourcePolicy");

const readPolicy = (resourceArn: string) =>
  Lambda.getResourcePolicy({ ResourceArn: resourceArn }).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

const serialize = (document: PolicyDocument | string) =>
  typeof document === "string" ? document : JSON.stringify(document);

export const ResourcePolicyProvider = () =>
  Provider.succeed(ResourcePolicy, {
    stables: ["resourceArn"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.resourceArn !== news.resourceArn) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceArn = output?.resourceArn ?? olds?.resourceArn;
      if (resourceArn === undefined) return undefined;
      const observed = yield* readPolicy(resourceArn);
      if (observed?.Policy === undefined) return undefined;
      const attrs = { resourceArn, revisionId: observed.RevisionId };
      // A policy has no tags; one this stack never wrote isn't ours.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      const resourceArn = news.resourceArn;
      const desired = serialize(news.policyDocument);
      // Observe, then put only when the policy differs. A put replaces the
      // resource's whole policy.
      const observed = yield* readPolicy(resourceArn);
      if (
        observed?.Policy !== undefined &&
        normalizePolicyDocument(observed.Policy) === normalizePolicyDocument(desired)
      ) {
        return { resourceArn, revisionId: observed.RevisionId };
      }
      yield* session.note(`Putting resource policy on ${resourceArn}...`);
      const put = yield* Lambda.putResourcePolicy({ ResourceArn: resourceArn, Policy: desired });
      return { resourceArn, revisionId: put.RevisionId };
    }),

    delete: Effect.fn(function* ({ output, session }) {
      yield* session.note(`Removing resource policy from ${output.resourceArn}...`);
      yield* Lambda.deleteResourcePolicy({ ResourceArn: output.resourceArn }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      );
    }),
  });
