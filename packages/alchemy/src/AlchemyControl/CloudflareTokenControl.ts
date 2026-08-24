import * as accounts from "@distilled.cloud/cloudflare/accounts";
import {
  apiKeyCredentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as CloudflareCredentials from "../Cloudflare/Credentials.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import {
  ControlInternalError,
  InvalidControlInput,
  type CloudflareGlobalCredentials,
  type CloudflarePermissionGroup,
  type CloudflareTokenPlan,
  type CloudflareTokenPlanInput,
  type CreateCloudflareTokenInput,
} from "./Surface.ts";

type Policy = {
  effect: "allow";
  permissionGroups: { id: string }[];
  resources: Record<string, string>;
};

const selectableScopes = new Set([
  "com.cloudflare.api.account",
  "com.cloudflare.api.account.zone",
  "com.cloudflare.api.user",
  "com.cloudflare.edge.r2.bucket",
]);

const policies = (
  accountIds: ReadonlyArray<string>,
  userId: string,
  groups: ReadonlyArray<CloudflarePermissionGroup>,
): Policy[] => {
  const buckets: Record<string, Policy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: Object.fromEntries(
        accountIds.map((id) => [`com.cloudflare.api.account.${id}`, "*"]),
      ),
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.api.account.zone.*": "*" },
    },
    "com.cloudflare.api.user": {
      effect: "allow",
      permissionGroups: [],
      resources: { [`com.cloudflare.api.user.${userId}`]: "*" },
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.edge.r2.bucket.*": "*" },
    },
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (bucket === undefined || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).filter(
    (policy) => policy.permissionGroups.length > 0,
  );
};

export const makeCloudflareTokenControl = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();

  const catalog = (credentials: CloudflareGlobalCredentials) =>
    internalize(
      Effect.gen(function* () {
        const listAccounts = yield* accounts.listAccounts;
        const listPermissionGroups = yield* user.listTokenPermissionGroups;
        const { accountResponse, permissionGroupResponse } = yield* Effect.all(
          {
            accountResponse: listAccounts({}),
            permissionGroupResponse: listPermissionGroups({}),
          },
          { concurrency: "unbounded" },
        );
        return {
          accounts: accountResponse.result.map(({ id, name }) => ({
            id,
            name,
          })),
          permissionGroups: permissionGroupResponse.result.flatMap((group) =>
            group.id && group.name && group.scopes?.length
              ? [
                  {
                    id: group.id,
                    name: group.name,
                    category: group.category ?? undefined,
                    scopes: group.scopes,
                    selectable: selectableScopes.has(group.scopes[0]!),
                  },
                ]
              : [],
          ),
        };
      }).pipe(
        Effect.provideService(
          CloudflareCredentials.Credentials,
          Effect.succeed(
            apiKeyCredentials({
              apiKey: Redacted.value(credentials.apiKey),
              email: credentials.email,
            }),
          ),
        ),
        Effect.provide(context),
      ),
    );

  const plan = (input: CloudflareTokenPlanInput) =>
    internalize(
      Effect.gen(function* () {
        const tokenCatalog = yield* catalog(input.credentials);
        const selected =
          input.permissionGroupIds === "all"
            ? tokenCatalog.permissionGroups
            : yield* Effect.forEach(input.permissionGroupIds, (id) => {
                const group = tokenCatalog.permissionGroups.find(
                  (candidate) => candidate.id === id,
                );
                if (group === undefined) {
                  return Effect.fail(
                    new InvalidControlInput({
                      field: "permissionGroupIds",
                      message: `Unknown Cloudflare permission group '${id}'.`,
                    }),
                  );
                }
                return Effect.succeed(group);
              });
        const currentUser = yield* user.getUser({}).pipe(
          Effect.provideService(
            CloudflareCredentials.Credentials,
            Effect.succeed(
              apiKeyCredentials({
                apiKey: Redacted.value(input.credentials.apiKey),
                email: input.credentials.email,
              }),
            ),
          ),
          Effect.provide(context),
        );
        const resolved = policies(input.accountIds, currentUser.id, selected);
        if (resolved.length === 0) {
          return yield* Effect.fail(
            new InvalidControlInput({
              field: "permissionGroupIds",
              message:
                "No selected permission groups can be expressed as token policies.",
            }),
          );
        }
        return {
          name: input.name,
          accountIds: input.accountIds,
          permissionGroupIds: selected.map(({ id }) => id),
          permissionCount: selected.length,
          grantsFullAccess: input.permissionGroupIds === "all",
          policies: resolved,
        } satisfies CloudflareTokenPlan;
      }),
    );

  const create = (input: CreateCloudflareTokenInput) =>
    internalize(
      Effect.gen(function* () {
        const result = yield* user.createToken({
          name: input.plan.name,
          policies: input.plan.policies as Policy[],
        });
        if (!result.value) {
          return yield* Effect.fail(
            new ControlInternalError({
              message: "Cloudflare did not return a token value.",
            }),
          );
        }
        const granted = (result.policies ?? []).reduce(
          (count, policy) => count + (policy.permissionGroups?.length ?? 0),
          0,
        );
        const verificationStatus = yield* user.verifyToken({}).pipe(
          Effect.provideService(
            CloudflareCredentials.Credentials,
            Effect.succeed(apiTokenCredentials({ apiToken: result.value })),
          ),
          Effect.map(({ status }) => status),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        return {
          id: result.id ?? "unknown",
          name: result.name ?? input.plan.name,
          value: Redacted.make(result.value),
          grantedPermissionGroups: granted,
          policies: result.policies ?? input.plan.policies,
          verificationStatus,
          diagnostics:
            granted === 0
              ? [
                  {
                    severity: "warning" as const,
                    code: "cloudflare.token.zero-permissions",
                    message:
                      "Cloudflare created the token with zero permissions.",
                  },
                ]
              : [],
        };
      }).pipe(
        Effect.provideService(
          CloudflareCredentials.Credentials,
          Effect.succeed(
            apiKeyCredentials({
              apiKey: Redacted.value(input.credentials.apiKey),
              email: input.credentials.email,
            }),
          ),
        ),
        Effect.provide(context),
      ),
    );

  return { catalog, plan, create };
});

/** Cloudflare API-token catalog, planning, and creation operations. */
export class CloudflareTokenControl extends Context.Service<
  CloudflareTokenControl,
  Effect.Success<typeof makeCloudflareTokenControl>
>()("alchemy/AlchemyControl/CloudflareToken") {}

/** Live Cloudflare token control implementation. */
export const CloudflareTokenControlLive = Layer.effect(
  CloudflareTokenControl,
  makeCloudflareTokenControl,
);
