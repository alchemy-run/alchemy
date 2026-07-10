import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * The Amazon Inspector scan types that can be enabled per account.
 */
export type ResourceScanType =
  | "EC2"
  | "ECR"
  | "LAMBDA"
  | "LAMBDA_CODE"
  | "CODE_REPOSITORY";

export interface EnablerProps {
  /**
   * The resource scan types to enable for the account (e.g. `EC2`, `ECR`,
   * `LAMBDA`). Types managed by this resource are disabled again on destroy.
   */
  resourceTypes: ResourceScanType[];
}

/** @resource */
export interface Enabler extends Resource<
  "AWS.Inspector2.Enabler",
  EnablerProps,
  {
    /** The account the enabler applies to. */
    accountId: string;
    /** The scan types currently enabled and managed by this resource. */
    resourceTypes: string[];
    /** The overall Inspector account status (`ENABLED` / `DISABLED` / ...). */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Amazon Inspector account enablement — an account/region singleton that turns
 * on continuous vulnerability scanning for the selected resource types (EC2,
 * ECR, Lambda). Inspector exposes no tagging, so ownership is tracked by the
 * set of scan types this resource enabled; destroy only disables those types
 * and leaves any the account had enabled out-of-band untouched.
 *
 * @section Enabling Inspector
 * @example Enable EC2, ECR, and Lambda scanning
 * ```typescript
 * const inspector = yield* Inspector2.Enabler("Inspector", {
 *   resourceTypes: ["EC2", "ECR", "LAMBDA"],
 * });
 * ```
 */
const EnablerResource = Resource<Enabler>("AWS.Inspector2.Enabler");

export { EnablerResource as Enabler };

// The scan-type keys as they appear on the account's `resourceState`, mapped to
// their `EnableRequest` resource-type names.
const RESOURCE_STATE_KEYS = {
  ec2: "EC2",
  ecr: "ECR",
  lambda: "LAMBDA",
  lambdaCode: "LAMBDA_CODE",
  codeRepository: "CODE_REPOSITORY",
} as const;

const TYPE_TO_STATE_KEY: Record<string, keyof typeof RESOURCE_STATE_KEYS> = {
  EC2: "ec2",
  ECR: "ecr",
  LAMBDA: "lambda",
  LAMBDA_CODE: "lambdaCode",
  CODE_REPOSITORY: "codeRepository",
};

const statusOfType = (
  resourceState: inspector2.ResourceState | undefined,
  type: string,
): string | undefined => {
  const key = TYPE_TO_STATE_KEY[type];
  if (!resourceState || !key) return undefined;
  return (resourceState as Record<string, inspector2.State | undefined>)[key]
    ?.status;
};

const enabledTypes = (
  resourceState: inspector2.ResourceState | undefined,
): string[] => {
  if (!resourceState) return [];
  const out: string[] = [];
  for (const [key, type] of Object.entries(RESOURCE_STATE_KEYS)) {
    const st = (resourceState as Record<string, inspector2.State | undefined>)[
      key
    ];
    if (st?.status === "ENABLED") out.push(type);
  }
  return out;
};

export const EnablerProvider = () =>
  Provider.effect(
    EnablerResource,
    Effect.gen(function* () {
      const getAccount = (accountId: string) =>
        inspector2
          .batchGetAccountStatus({ accountIds: [accountId] })
          .pipe(Effect.map((r) => r.accounts?.[0]));

      // Enablement is fast (~10–20s per type). Poll until every desired type
      // reaches the terminal `ENABLED` state so a subsequent destroy can
      // cleanly disable it (disable is rejected while a type is `ENABLING`).
      const waitUntilEnabled = (accountId: string, types: string[]) =>
        getAccount(accountId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (account) =>
              types.every(
                (t) => statusOfType(account?.resourceState, t) === "ENABLED",
              ),
            times: 24,
          }),
        );

      return {
        read: Effect.fn(function* ({ output }) {
          const accountId =
            output?.accountId ?? (yield* AWSEnvironment.current).accountId;
          const account = yield* getAccount(accountId);
          if (!account) return undefined;
          const enabled = enabledTypes(account.resourceState);
          if (enabled.length === 0) return undefined;
          return {
            accountId,
            resourceTypes: enabled,
            state: account.state?.status,
          };
        }),

        // Inspector enablement is an account/region singleton keyed on the
        // caller's account. Report the single account status.
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const account = yield* getAccount(accountId);
            const enabled = enabledTypes(account?.resourceState);
            if (!account || enabled.length === 0) return [];
            return [
              {
                accountId,
                resourceTypes: enabled,
                state: account.state?.status,
              },
            ];
          }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const desired = news.resourceTypes ?? [];

          // 1. OBSERVE
          const account = yield* getAccount(accountId);
          const currentlyEnabled = enabledTypes(account?.resourceState);

          // 2. ENSURE — enable any desired type not yet enabled.
          const toEnable = desired.filter((t) => !currentlyEnabled.includes(t));
          if (toEnable.length > 0) {
            yield* inspector2.enable({
              accountIds: [accountId],
              resourceTypes: toEnable,
            });
          }

          // Wait for the desired types to reach the terminal ENABLED state
          // before returning — otherwise a follow-up destroy would be rejected
          // with ENABLE_IN_PROGRESS.
          if (toEnable.length > 0) {
            yield* waitUntilEnabled(accountId, desired);
          }

          // 3. SYNC — disable any type we previously managed but no longer want.
          // Disable teardown is slow (minutes); fire it and do not block, the
          // account converges to the desired set asynchronously.
          const previouslyManaged = output?.resourceTypes ?? [];
          const toDisable = previouslyManaged.filter(
            (t) => !desired.includes(t) && currentlyEnabled.includes(t),
          );
          if (toDisable.length > 0) {
            yield* inspector2.disable({
              accountIds: [accountId],
              resourceTypes: toDisable,
            });
          }

          const final = yield* getAccount(accountId);
          yield* session.note(accountId);
          return {
            accountId,
            resourceTypes: desired,
            state: final?.state?.status,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          if (output.resourceTypes.length === 0) return;
          yield* inspector2
            .disable({
              accountIds: [output.accountId],
              resourceTypes: output.resourceTypes,
            })
            .pipe(
              Effect.catchTag("ValidationException", () => Effect.void),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
