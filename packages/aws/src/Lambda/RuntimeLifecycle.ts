/**
 * Helpers shared by `AWS.Lambda.Runtime`, `RuntimeVersion` and
 * `RuntimeAlias`.
 *
 * NOT exported from `index.ts`.
 */
import type * as lambdacore from "@distilled.cloud/aws/lambda-core";
import type { RuntimeReleaseLifecycle } from "./Runtime.ts";

/**
 * The recovery window for a delete. An account-wide teardown (`force`)
 * reads Attributes rather than Props, so it uses the shortest window Lambda
 * allows instead of the 30-day default.
 */
export const recoveryWindowOf = (days: number | undefined, force: boolean | undefined) =>
  days ?? (force ? 7 : undefined);

export const toLifecycle = (
  lifecycle: RuntimeReleaseLifecycle | undefined,
): lambdacore.RuntimeReleaseLifecycle | undefined =>
  lifecycle === undefined
    ? undefined
    : {
        ReleaseState: lifecycle.releaseState,
        DeprecationDate: lifecycle.deprecationDate,
        FunctionCreateBlockDate: lifecycle.functionCreateBlockDate,
        FunctionUpdateBlockDate: lifecycle.functionUpdateBlockDate,
      };

export const fromLifecycle = (
  lifecycle: lambdacore.RuntimeReleaseLifecycle | undefined,
): RuntimeReleaseLifecycle | undefined => {
  if (lifecycle === undefined) return undefined;
  const value: RuntimeReleaseLifecycle = {
    ...(lifecycle.ReleaseState === undefined
      ? {}
      : { releaseState: lifecycle.ReleaseState as RuntimeReleaseLifecycle["releaseState"] }),
    ...(lifecycle.DeprecationDate === undefined
      ? {}
      : { deprecationDate: lifecycle.DeprecationDate }),
    ...(lifecycle.FunctionCreateBlockDate === undefined
      ? {}
      : { functionCreateBlockDate: lifecycle.FunctionCreateBlockDate }),
    ...(lifecycle.FunctionUpdateBlockDate === undefined
      ? {}
      : { functionUpdateBlockDate: lifecycle.FunctionUpdateBlockDate }),
  };
  return Object.keys(value).length === 0 ? undefined : value;
};

export const lifecycleEqual = (
  a: RuntimeReleaseLifecycle | undefined,
  b: RuntimeReleaseLifecycle | undefined,
) =>
  a?.releaseState === b?.releaseState &&
  a?.deprecationDate === b?.deprecationDate &&
  a?.functionCreateBlockDate === b?.functionCreateBlockDate &&
  a?.functionUpdateBlockDate === b?.functionUpdateBlockDate;
