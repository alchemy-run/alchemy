import * as functions from "@distilled.cloud/stackit/functions";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { getServiceStatus } from "../internal/enable.ts";

/** The STACKIT service id Functions is enabled under. */
export const FUNCTIONS_SERVICE_ID = "cloud.stackit.functions";

/**
 * ASSUMPTION for the first live deploy: the port a Function's container listens
 * on. STACKIT documents no container contract, and the API has no port field.
 * It is the image's `PORT` default, so a `PORT` the platform injects still wins.
 * This is the one place to change it.
 */
export const FUNCTION_PORT = 8080;

/**
 * ASSUMPTION for the first live deploy: the platform images are built for. The API
 * has no architecture field.
 */
export const FUNCTION_PLATFORM = "linux/amd64";

/**
 * `limits.plan` when the user names none. The API has no plan list; `f2` is the
 * value in STACKIT's Go SDK example (`examples/functions/functions.go`). Whether
 * it is the smallest plan is unverified.
 */
export const DEFAULT_FUNCTION_PLAN = "f2";

/** `limits.concurrency` when the user names none: the spec's and Go SDK's example. */
export const DEFAULT_FUNCTION_CONCURRENCY = 100;

/** Older revisions kept next to the active one. */
export const DEFAULT_KEEP_REVISIONS = 1;

/** Longest generated function name. The spec states no limit, so this is ours. */
export const FUNCTION_NAME_MAX_LENGTH = 63;

/** Longest pull credential name (spec: `maxLength: 32`). */
export const PULL_CREDENTIAL_NAME_MAX_LENGTH = 32;

/** The spec's `oci_reference` pattern: a semver tag or a digest. */
export const OCI_REFERENCE_PATTERN =
  /(:[vV]?\d+\.\d+\.\d+(@sha256:[a-fA-F0-9]{64})?)$|((:latest)?@sha256:[a-fA-F0-9]{64})$/;

/** Budget for a revision to go active: the Go SDK's `CreateRevisionWaitHandler` uses 10 minutes. */
export const REVISION_TIMEOUT = "10 minutes";

/** Budget for an active revision to become the function's current one. */
export const PROMOTION_TIMEOUT = "2 minutes";

/** Budget for a deleted function to disappear; the API reports no typical time. */
export const DELETE_TIMEOUT = "5 minutes";

/**
 * A list response asks for a next page. The API returns `next_page_token`, but
 * neither its spec nor its Go SDK has a parameter to send it back. Failing beats
 * a silently partial answer, which would hide resources from `read` and `list`.
 */
export class FunctionsListTruncated extends Data.TaggedError("Stackit.Functions.ListTruncated")<{
  readonly list: string;
  readonly message: string;
}> {}

const wholeList = <A>(
  list: string,
  token: string | undefined,
  items: ReadonlyArray<A> | undefined,
) =>
  token === undefined || token === ""
    ? Effect.succeed(items ?? [])
    : Effect.fail(
        new FunctionsListTruncated({
          list,
          message: `${list} has more than one page, and the STACKIT Functions API has no way to request the next one`,
        }),
      );

/** Whether Functions is enabled for a project: a project that isn't has no functions. */
export const isFunctionsEnabled = (projectId: string, region: string) =>
  getServiceStatus({ projectId, region, serviceId: FUNCTIONS_SERVICE_ID }).pipe(
    Effect.map((status) => status.state === "ENABLED"),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/** Every function of a project. */
export const listAllFunctions = (projectId: string) =>
  functions
    .listFunctions({ projectId })
    .pipe(
      Effect.flatMap((page) =>
        wholeList(`functions of ${projectId}`, page.next_page_token, page.functions),
      ),
    );

/** Every revision of a function. */
export const listAllRevisions = (projectId: string, functionId: string) =>
  functions
    .listRevisions({ projectId, functionId })
    .pipe(
      Effect.flatMap((page) =>
        wholeList(`revisions of ${functionId}`, page.next_page_token, page.revisionList),
      ),
    );

/** Every pull credential of a project. */
export const listAllPullCredentials = (projectId: string) =>
  functions
    .listPullCredentials({ projectId })
    .pipe(
      Effect.flatMap((page) =>
        wholeList(`pull credentials of ${projectId}`, page.next_page_token, page.pull_credentials),
      ),
    );

/** Read a function by id; `undefined` when it is missing. */
export const getFunctionOrUndefined = (projectId: string, functionId: string) =>
  functions
    .getFunction({ projectId, functionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Read a revision by id; `undefined` when it is missing. */
export const getRevisionOrUndefined = (projectId: string, functionId: string, revisionId: string) =>
  functions
    .getRevision({ projectId, functionId, revisionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Read a pull credential by id; `undefined` when it is missing. */
export const getPullCredentialOrUndefined = (projectId: string, pullCredentialId: string) =>
  functions
    .getPullCredential({ projectId, pullCredentialId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
