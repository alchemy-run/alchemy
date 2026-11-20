import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { App } from "../App.ts";
import type { Compute } from "../Compute.ts";
import { normalizeHostname } from "./Hostname.ts";

export class RoutingUrlOperationFailed extends Data.TaggedError("RoutingUrlOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The service is on no Branch, so it cannot serve a RoutingUrl. Attach the
 * app to a Branch, then redeploy.
 */
export class RoutingUrlServiceNotOnABranch extends Data.TaggedError(
  "RoutingUrlServiceNotOnABranch",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const notOnABranch = (serviceId: string, cause?: unknown) =>
  new RoutingUrlServiceNotOnABranch({
    message: `Prisma service '${serviceId}' is not on a Branch, so it cannot serve a RoutingUrl. Attach the app to a Branch, for example with branchId or branchGitName on the App or Compute, then redeploy.`,
    cause,
  });

export type AppReference = string | App | Compute;

export const appIdValue = (app: AppReference | undefined) =>
  typeof app === "string" ? app : app?.appId;

export const resolveServiceId = (app: AppReference) => {
  const value = appIdValue(app);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
        new RoutingUrlOperationFailed({ message: "Unable to resolve the Prisma app id." }),
      );
};

/**
 * Whether a RoutingUrl row has a `logicalId`. Every client that manages a row,
 * such as `Prisma.RoutingUrl` or Composer, writes one; Prisma leaves it empty
 * on the rows its backfill, the Console and custom domains make.
 */
export const hasLogicalId = (row: { readonly logicalId: string | null }) => row.logicalId !== null;

/** Whether one of `rows` for `hostname` has a `logicalId`. */
export const hostnameHasLogicalId = (
  rows: ReadonlyArray<{ readonly logicalId: string | null; readonly hostname: string }>,
  hostname: string,
) =>
  rows.some(
    (row) => hasLogicalId(row) && normalizeHostname(row.hostname) === normalizeHostname(hostname),
  );
