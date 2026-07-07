import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface PolicyAttachmentProps {
  /**
   * Policy to attach.
   */
  policyId: string;
  /**
   * Target root, OU, or account ID.
   */
  targetId: string;
}

export interface PolicyAttachment extends Resource<
  "AWS.Organizations.PolicyAttachment",
  PolicyAttachmentProps,
  {
    policyId: string;
    targetId: string;
    targetArn: string | undefined;
    targetName: string | undefined;
    targetType: organizations.TargetType | undefined;
  },
  never,
  Providers
> {}

/**
 * Attaches an Organizations policy to a root, OU, or account.
 * @resource
 */
export const PolicyAttachment = Resource<PolicyAttachment>(
  "AWS.Organizations.PolicyAttachment",
);

export const PolicyAttachmentProvider = () =>
  Provider.effect(
    PolicyAttachment,
    Effect.gen(function* () {
      return {
        stables: ["policyId", "targetId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.policyId !== news.policyId ||
            olds?.targetId !== news.targetId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readAttachment({
            policyId: output?.policyId ?? olds!.policyId,
            targetId: output?.targetId ?? olds!.targetId,
          });
        }),
        // Enumerate every (policy, target) attachment. There is no direct
        // "list attachments" API, so we fan out: for each policy type, list the
        // policies of that type, then list each policy's targets, emitting one
        // Attributes per (policy, target) pair — the exact shape `read` returns.
        // listPolicies/listTargetsForPolicy may only be called from the org
        // management account or a delegated administrator; a member account or a
        // standalone account that isn't part of an org rejects with the typed
        // AccessDeniedException / AWSOrganizationsNotInUseException, which we
        // degrade to [].
        list: () =>
          Effect.gen(function* () {
            const perType = yield* Effect.forEach(
              POLICY_TYPES,
              (Filter) =>
                Effect.gen(function* () {
                  const policies = yield* retryOrganizations(
                    collectPages(
                      (NextToken) =>
                        organizations.listPolicies({ Filter, NextToken }),
                      (page) => page.Policies,
                    ),
                  );
                  const policyIds = policies
                    .map((policy) => policy.Id)
                    .filter((id): id is string => id != null);
                  const perPolicy = yield* Effect.forEach(
                    policyIds,
                    (policyId) => listAttachmentsForPolicy(policyId),
                    { concurrency: 10 },
                  );
                  return perPolicy.flat();
                }),
              { concurrency: 10 },
            );
            return perType.flat();
          }).pipe(
            Effect.catchTags({
              AccessDeniedException: () =>
                Effect.succeed([] as PolicyAttachment["Attributes"][]),
              AWSOrganizationsNotInUseException: () =>
                Effect.succeed([] as PolicyAttachment["Attributes"][]),
            }),
          ),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — list current attachments to see whether ours is present.
          // The attachment is identity-only; both `policyId` and `targetId`
          // are stable, so `diff` handles any change as a replacement.
          let state = yield* readAttachment(news);

          // Ensure — attach if missing. `DuplicatePolicyAttachmentException`
          // is treated as success (e.g. a peer reconciler attached
          // concurrently, or our observation lost a race).
          if (!state) {
            yield* retryOrganizations(
              organizations
                .attachPolicy({
                  PolicyId: news.policyId,
                  TargetId: news.targetId,
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicatePolicyAttachmentException",
                    () => Effect.void,
                  ),
                ),
            );
            state = yield* readAttachment(news);
            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `policy attachment '${news.policyId}' -> '${news.targetId}' not found after create`,
                ),
              );
            }
          }

          yield* session.note(`${state.policyId}:${state.targetId}`);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .detachPolicy({
                PolicyId: output.policyId,
                TargetId: output.targetId,
              })
              .pipe(
                Effect.catchTags({
                  PolicyNotAttachedException: () => Effect.void,
                  PolicyNotFoundException: () => Effect.void,
                  TargetNotFoundException: () => Effect.void,
                }),
              ),
          );
        }),
      };
    }),
  );

// All policy types that can be attached to a root, OU, or account. `list()`
// fans out over each of these because listPolicies requires an explicit
// `Filter` and only returns policies of that single type.
const POLICY_TYPES = [
  "SERVICE_CONTROL_POLICY",
  "RESOURCE_CONTROL_POLICY",
  "TAG_POLICY",
  "BACKUP_POLICY",
  "AISERVICES_OPT_OUT_POLICY",
  "CHATBOT_POLICY",
  "DECLARATIVE_POLICY_EC2",
  "SECURITYHUB_POLICY",
  "INSPECTOR_POLICY",
  "UPGRADE_ROLLOUT_POLICY",
  "BEDROCK_POLICY",
  "S3_POLICY",
  "NETWORK_SECURITY_DIRECTOR_POLICY",
] as const satisfies readonly organizations.PolicyType[];

const listAttachmentsForPolicy = (policyId: string) =>
  retryOrganizations(
    collectPages(
      (NextToken) =>
        organizations.listTargetsForPolicy({ PolicyId: policyId, NextToken }),
      (page) => page.Targets,
    ),
  ).pipe(
    Effect.map((targets) =>
      targets
        .filter(
          (
            target,
          ): target is organizations.PolicyTargetSummary & {
            TargetId: string;
          } => target.TargetId != null,
        )
        .map(
          (target) =>
            ({
              policyId,
              targetId: target.TargetId,
              targetArn: target.Arn,
              targetName: target.Name,
              targetType: target.Type,
            }) satisfies PolicyAttachment["Attributes"],
        ),
    ),
    // The policy was deleted between enumeration and target read — skip it.
    Effect.catchTag("PolicyNotFoundException", () =>
      Effect.succeed([] as PolicyAttachment["Attributes"][]),
    ),
  );

const readAttachment = Effect.fn(function* ({
  policyId,
  targetId,
}: PolicyAttachmentProps) {
  const targets = yield* retryOrganizations(
    collectPages(
      (NextToken) =>
        organizations.listTargetsForPolicy({ PolicyId: policyId, NextToken }),
      (page) => page.Targets,
    ),
  );

  const target = targets.find((candidate) => candidate.TargetId === targetId);
  return target
    ? ({
        policyId,
        targetId,
        targetArn: target.Arn,
        targetName: target.Name,
        targetType: target.Type,
      } satisfies PolicyAttachment["Attributes"])
    : undefined;
});
