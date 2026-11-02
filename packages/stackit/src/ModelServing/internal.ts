/**
 * Shared lifecycle helpers of `Stackit.ModelServing`. Not exported from the namespace barrel.
 */
import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/** Service enablement id, from the spec's `x-stackit-authorization`. */
export const MODEL_SERVING_SERVICE_ID = "cloud.stackit.model-serving";

/** Token create, update and delete budget (the Go SDK's wait handlers, 10 minutes). */
export const TOKEN_TIMEOUT = "10 minutes";

/** The API's limit on a token's `name`. */
export const TOKEN_NAME_MAX_LENGTH = 200;

/** A scope as a request's path parameters. */
export const scopeRequest = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** A token, or `undefined` once it is gone. The API never returns its value here. */
export const getTokenOrUndefined = (scope: ProjectScope, tId: string) =>
  modelServing.getToken({ ...scopeRequest(scope), tId }).pipe(
    Effect.map(({ token }) => token),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * The tokens of a scope. The API doesn't page this list. It has a `label_selector`, whose syntax
 * no STACKIT source documents, so ownership is filtered here.
 */
export const listScopeTokens = (scope: ProjectScope) =>
  modelServing
    .listTokens(scopeRequest(scope))
    .pipe(Effect.map(({ tokens }) => tokens.filter((token) => token.state !== "deleting")));
