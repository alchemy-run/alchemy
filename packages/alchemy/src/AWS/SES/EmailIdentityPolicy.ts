import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface EmailIdentityPolicyProps {
  /**
   * The email address or domain identity the sending-authorization policy is
   * attached to. Typically the `emailIdentity` output of a
   * `SES.EmailIdentity`. Changing it replaces the policy.
   */
  emailIdentity: string;
  /**
   * Name of the policy. May contain letters, numbers, dashes and underscores,
   * up to 64 characters. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * policy.
   */
  policyName?: string;
  /**
   * The sending-authorization policy document as a JSON string. Whitespace and
   * formatting differences are ignored when detecting drift.
   */
  policy: string;
}

export interface EmailIdentityPolicy extends Resource<
  "AWS.SES.EmailIdentityPolicy",
  EmailIdentityPolicyProps,
  {
    /** The identity the policy is attached to. */
    emailIdentity: string;
    /** Name of the policy. */
    policyName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 sending-authorization policy attached to an email identity —
 * lets the identity owner authorize other AWS accounts or IAM principals to
 * send email using the identity.
 *
 * The policy document is an IAM-style JSON string; SES stores it verbatim, so
 * only the parsed content matters when detecting drift.
 * @resource
 * @section Attaching a Policy
 * @example Authorize Another Account to Send
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.example.com",
 * });
 *
 * const policy = yield* SES.EmailIdentityPolicy("AllowPartner", {
 *   emailIdentity: identity.emailIdentity,
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *         Action: "ses:SendEmail",
 *         Resource: identity.identityArn,
 *       },
 *     ],
 *   }),
 * });
 * ```
 */
export const EmailIdentityPolicy = Resource<EmailIdentityPolicy>(
  "AWS.SES.EmailIdentityPolicy",
);

/**
 * Normalise a policy JSON string for drift comparison so that pretty-printed
 * input and SES's stored representation compare equal. Falls back to the raw
 * string when the value is not valid JSON.
 */
const normalizePolicy = (policy: string): string => {
  try {
    return JSON.stringify(JSON.parse(policy));
  } catch {
    return policy;
  }
};

export const EmailIdentityPolicyProvider = () =>
  Provider.effect(
    EmailIdentityPolicy,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<EmailIdentityPolicyProps, "policyName">,
      ) {
        return (
          props.policyName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      // Returns the policy-name -> document map for the identity, or undefined
      // when the identity itself no longer exists.
      const getPolicies = Effect.fn(function* (emailIdentity: string) {
        return yield* sesv2
          .getEmailIdentityPolicies({ EmailIdentity: emailIdentity })
          .pipe(
            Effect.map((response) => response.Policies ?? {}),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return EmailIdentityPolicy.Provider.of({
        stables: ["emailIdentity", "policyName"],

        // Policies are keyed entirely by their parent identity; there is no
        // flat account-level enumeration, and deleting the identity removes
        // its policies, so nuke handles them via the parent identity.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const emailIdentity = output?.emailIdentity ?? olds?.emailIdentity;
          if (emailIdentity === undefined) return undefined;
          const policyName =
            output?.policyName ?? (yield* createName(id, olds ?? {}));
          const policies = yield* getPolicies(emailIdentity);
          if (policies === undefined || policies[policyName] === undefined) {
            return undefined;
          }
          // Policies carry no tags, so existence at our deterministic name is
          // treated as ownership.
          return { emailIdentity, policyName };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            olds.emailIdentity !== news.emailIdentity
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const emailIdentity = output?.emailIdentity ?? news.emailIdentity;
          const policyName =
            output?.policyName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          const policies = yield* getPolicies(emailIdentity);
          const existing = policies?.[policyName];

          if (existing === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createEmailIdentityPolicy({
                EmailIdentity: emailIdentity,
                PolicyName: policyName,
                Policy: news.policy,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateEmailIdentityPolicy({
                    EmailIdentity: emailIdentity,
                    PolicyName: policyName,
                    Policy: news.policy,
                  }),
                ),
              );
          } else {
            // 3. SYNC — update only when the stored document differs.
            const changed = yield* Effect.sync(
              () => normalizePolicy(existing) !== normalizePolicy(news.policy),
            );
            if (changed) {
              yield* sesv2.updateEmailIdentityPolicy({
                EmailIdentity: emailIdentity,
                PolicyName: policyName,
                Policy: news.policy,
              });
            }
          }

          return { emailIdentity, policyName };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteEmailIdentityPolicy succeeds even if the policy is absent; a
          // missing identity means the policy is already gone.
          yield* sesv2
            .deleteEmailIdentityPolicy({
              EmailIdentity: output.emailIdentity,
              PolicyName: output.policyName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
