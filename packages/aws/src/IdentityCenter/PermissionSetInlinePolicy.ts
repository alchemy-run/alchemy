import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { PolicyDocument } from "../IAM/Policy.ts";
import { normalizePolicyDocument, stringifyPolicyDocument } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import { adoptionAllowed, bareIdentifier, resolveInstance, retryIdentityCenter } from "./common.ts";

export class PermissionSetInlinePolicyUnexpectedResponse extends Data.TaggedError(
  "PermissionSetInlinePolicyUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PermissionSetProvisioningInProgress extends Data.TaggedError(
  "PermissionSetProvisioningInProgress",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PermissionSetProvisioningFailed extends Data.TaggedError(
  "PermissionSetProvisioningFailed",
)<{
  readonly message: string;
  readonly permissionSetArn: string;
  readonly accountId?: string;
}> {}

export interface PermissionSetInlinePolicyProps {
  /**
   * Explicit IAM Identity Center instance ARN.
   * If omitted, Alchemy adopts the only visible instance.
   */
  instanceArn?: string;
  /**
   * The permission set the policy is put on. A permission set holds one
   * inline policy.
   */
  permissionSetArn: string;
  /**
   * The inline policy. Accepts a typed {@link PolicyDocument} or a raw JSON
   * string.
   */
  policyDocument: PolicyDocument | string;
}

export interface PermissionSetInlinePolicy extends Resource<
  "AWS.IdentityCenter.PermissionSetInlinePolicy",
  PermissionSetInlinePolicyProps,
  {
    /** The Identity Center instance the permission set lives in. */
    instanceArn: string;
    /** The permission set the policy is put on. */
    permissionSetArn: string;
    /** The inline policy (canonical JSON), as observed. */
    policyDocument: string;
  },
  never,
  Providers
> {}

/**
 * The inline policy of an IAM Identity Center permission set
 * (`PutInlinePolicyToPermissionSet`).
 *
 * Accounts pick up a policy change only once the permission set is
 * provisioned to them again, so after a change this re-provisions every
 * account the permission set is provisioned to and waits for the result with
 * up to 120 retries, two seconds apart. On each create or update, and after
 * an interrupted one, it also re-provisions accounts still on an older
 * version, such as after a provisioning that failed.
 *
 * An existing policy requires explicit adoption (`--adopt` or `adopt(true)`)
 * before it is overwritten. If a put succeeds before its identity is saved,
 * inspect the policy and explicitly adopt it to resume.
 *
 * Pointing it at another permission set moves the policy: it is put on the
 * new set, then deleted from the old one, and each set's accounts are
 * provisioned again. Swapping permission sets between two inline policies in
 * one deploy isn't supported (each may delete the policy the other just put);
 * split it across two deploys.
 * ### Granting Permissions
 * **Example:** Read Secrets Under A Path
 * ```typescript
 * const developer = yield* PermissionSet("Developer", { name: "Developer" });
 *
 * yield* PermissionSetInlinePolicy("DeveloperPolicy", {
 *   permissionSetArn: developer.permissionSetArn,
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Action: ["secretsmanager:GetSecretValue"],
 *         Resource: ["arn:aws:secretsmanager:*:*:secret:development/*"],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const PermissionSetInlinePolicy = Resource<PermissionSetInlinePolicy>(
  "AWS.IdentityCenter.PermissionSetInlinePolicy",
);

export const PermissionSetInlinePolicyProvider = () =>
  Provider.effect(
    PermissionSetInlinePolicy,
    Effect.gen(function* () {
      // This lock is scoped to the provider layer instance. Layer memoization can
      // share that instance across stacks and deployments; separate
      // instances/processes do not share it.
      const gate = Semaphore.makeUnsafe(1);
      return {
        // No `diff`: another permission set is an update that moves the
        // policy (see `reconcile`). A replace would put the policy on the
        // same set when the props name it another way, and its cleanup would
        // then delete it.
        read: Effect.fn(function* ({ olds, output }) {
          const permissionSetArn = output?.permissionSetArn ?? olds?.permissionSetArn;
          if (!permissionSetArn) return undefined;
          const instance = yield* resolveInstance(output?.instanceArn ?? olds?.instanceArn);
          const existing = yield* readInlinePolicy(instance.InstanceArn!, permissionSetArn);
          return existing === undefined || output !== undefined ? existing : Unowned(existing);
        }),
        reconcile: Effect.fn(
          function* ({ id, fqn, news, output, session }) {
            const instance = yield* resolveInstance(news.instanceArn ?? output?.instanceArn);
            const instanceArn = instance.InstanceArn!;
            const desiredJson =
              typeof news.policyDocument === "string"
                ? news.policyDocument
                : stringifyPolicyDocument(news.policyDocument);
            const desired = normalizePolicyDocument(desiredJson);

            // Observe — the permission set's current inline policy, if any.
            const observed = yield* readInlinePolicy(instanceArn, news.permissionSetArn);
            const sameTarget =
              output !== undefined &&
              output.instanceArn === instanceArn &&
              bareIdentifier(output.permissionSetArn) === bareIdentifier(news.permissionSetArn);
            if (observed !== undefined && !sameTarget && !(yield* adoptionAllowed(fqn))) {
              return yield* new OwnedBySomeoneElse({
                message: `Inline policy on '${news.permissionSetArn}' already exists. Use --adopt or adopt(true) to take it over.`,
                resourceType: PermissionSetInlinePolicy.Type,
                logicalId: id,
                physicalName: news.permissionSetArn,
              });
            }

            // Sync — put the policy only when it differs. A put leaves every
            // account the set is provisioned to on the old version, so all of
            // them are provisioned again. Without a put, the accounts Identity
            // Center reports as not on the latest version still are: a
            // provisioning that failed on an earlier deploy is retried here.
            const put = observed?.policyDocument !== desired;
            if (put) {
              yield* retryIdentityCenter(
                ssoAdmin.putInlinePolicyToPermissionSet({
                  InstanceArn: instanceArn,
                  PermissionSetArn: news.permissionSetArn,
                  InlinePolicy: desiredJson,
                }),
              );
            }
            yield* reprovisionPermissionSet(
              instanceArn,
              news.permissionSetArn,
              put ? undefined : "LATEST_PERMISSION_SET_NOT_PROVISIONED",
            );

            // Prune — the props moved the policy to another permission set, so
            // it leaves the one `output` records. This is an update, not a
            // replace, because a permission set the same deploy creates is
            // unknown when the plan is made. A crash after the delete leaves
            // the resource updating, and the retry still re-provisions the old
            // set's accounts that are not on its latest version.
            if (output !== undefined && !sameTarget) {
              yield* removeInlinePolicy(output.instanceArn, output.permissionSetArn);
            }

            yield* session.note(news.permissionSetArn);
            const fresh = yield* readInlinePolicy(instanceArn, news.permissionSetArn);
            if (!fresh) {
              return yield* new PermissionSetInlinePolicyUnexpectedResponse({
                message: `inline policy on '${news.permissionSetArn}' not found after reconciliation`,
              });
            }
            return fresh;
          },
          Semaphore.withPermits(gate, 1),
        ),
        delete: Effect.fn(function* ({ output }) {
          yield* removeInlinePolicy(output.instanceArn, output.permissionSetArn);
        }),
      };
    }),
  );

/**
 * Delete the permission set's inline policy and provision the set again to
 * its accounts. When the policy is already gone (a retry after a crash), only
 * the accounts not on the set's latest version are provisioned again. A
 * permission set that no longer exists needs nothing.
 */
const removeInlinePolicy = Effect.fn(function* (instanceArn: string, permissionSetArn: string) {
  const observed = yield* readInlinePolicy(instanceArn, permissionSetArn);
  if (observed) {
    yield* retryIdentityCenter(
      ssoAdmin
        .deleteInlinePolicyFromPermissionSet({
          InstanceArn: instanceArn,
          PermissionSetArn: permissionSetArn,
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    );
  }
  yield* reprovisionPermissionSet(
    instanceArn,
    permissionSetArn,
    observed ? undefined : "LATEST_PERMISSION_SET_NOT_PROVISIONED",
  ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
});

const readInlinePolicy = Effect.fn(function* (instanceArn: string, permissionSetArn: string) {
  const response = yield* retryIdentityCenter(
    ssoAdmin
      .getInlinePolicyForPermissionSet({
        InstanceArn: instanceArn,
        PermissionSetArn: permissionSetArn,
      })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined)),
  );
  // An empty `InlinePolicy` means the permission set has none.
  if (!response?.InlinePolicy) return undefined;
  return {
    instanceArn,
    permissionSetArn,
    policyDocument: normalizePolicyDocument(response.InlinePolicy),
  } satisfies PermissionSetInlinePolicy["Attributes"];
});

/**
 * Provision the permission set again to every account it is provisioned to,
 * and wait until Identity Center reports the result. With `status`, only when
 * some account has that provisioning status. A permission set provisioned to
 * no such account needs nothing.
 */
const reprovisionPermissionSet = Effect.fn(function* (
  instanceArn: string,
  permissionSetArn: string,
  status?: ssoAdmin.ProvisioningStatus,
) {
  const accounts = yield* retryIdentityCenter(
    ssoAdmin.listAccountsForProvisionedPermissionSet
      .items({
        InstanceArn: instanceArn,
        PermissionSetArn: permissionSetArn,
        ProvisioningStatus: status,
        MaxResults: 100,
      })
      .pipe(Stream.runCollect),
  );
  if (Array.from(accounts).length === 0) return;

  const response = yield* retryIdentityCenter(
    ssoAdmin.provisionPermissionSet({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn,
      TargetType: "ALL_PROVISIONED_ACCOUNTS",
    }),
  );
  const requestId = response.PermissionSetProvisioningStatus?.RequestId;
  if (!requestId) {
    return yield* new PermissionSetProvisioningFailed({
      message: "permission set provisioning returned no request ID",
      permissionSetArn,
    });
  }
  yield* waitForProvisioning(instanceArn, permissionSetArn, requestId);
});

const waitForProvisioning = (instanceArn: string, permissionSetArn: string, requestId: string) =>
  Effect.gen(function* () {
    const response = yield* retryIdentityCenter(
      ssoAdmin.describePermissionSetProvisioningStatus({
        InstanceArn: instanceArn,
        ProvisionPermissionSetRequestId: requestId,
      }),
    );
    const status = response.PermissionSetProvisioningStatus;

    if (!status?.Status || status.Status === "IN_PROGRESS") {
      return yield* new PermissionSetProvisioningInProgress({
        message: `permission set '${permissionSetArn}' provisioning request '${requestId}' is still in progress`,
      });
    }

    if (status.Status === "FAILED") {
      return yield* new PermissionSetProvisioningFailed({
        message: `permission set provisioning failed: ${status.FailureReason ?? "unknown failure"}`,
        permissionSetArn,
        accountId: status.AccountId,
      });
    }

    return status;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "PermissionSetProvisioningInProgress",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(120)]),
    }),
  );
