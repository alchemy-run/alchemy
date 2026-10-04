import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  OAUTH_UNGRANTABLE_PERMISSION_GROUPS,
  selectableScopes,
  tokenPolicies,
  type PermissionGroup,
  type TokenPolicy,
} from "../../Cloudflare/Auth/TokenPolicy.ts";
import * as CloudflareCredentials from "../../Cloudflare/Credentials.ts";
import { AlchemistInvalidInput, type Diagnostic } from "../Errors.ts";

export interface CatalogInput {
  readonly credentials: CloudflareCredentials.Credentials["Service"];
  readonly accountId?: string;
}

export interface Account {
  readonly id: string;
  readonly name: string;
}

export type { PermissionGroup, TokenPolicy } from "../../Cloudflare/Auth/TokenPolicy.ts";

export interface TokenCatalog {
  readonly accounts: ReadonlyArray<Account>;
  readonly permissionGroups: ReadonlyArray<PermissionGroup>;
  readonly unavailablePermissionGroups: ReadonlyArray<string>;
}

export interface PlanInput extends CatalogInput {
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string> | "all";
}

export interface TokenPlan {
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string>;
  readonly permissionCount: number;
  readonly grantsFullAccess: boolean;
  readonly policies: ReadonlyArray<TokenPolicy>;
}

export interface CreateInput extends CatalogInput {
  readonly plan: TokenPlan;
}

export interface CreatedToken {
  readonly id: string;
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
  readonly grantedPermissionGroups: number;
  /** Echoed back by Cloudflare; may contain effects we never request. */
  readonly policies: ReadonlyArray<unknown>;
  readonly verificationStatus?: string;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/** Cloudflare accepted the create call but returned no usable token. */
export class CloudflareTokenError extends Data.TaggedError("CloudflareTokenError")<{
  readonly message: string;
}> {}

const withCredentials = (input: CatalogInput) =>
  Effect.provideService(CloudflareCredentials.Credentials, input.credentials);

/** The accounts and permission groups a token can be scoped to. */
export const catalog = Effect.fn("Alchemist.cloudflare.token.catalog")(
  function* ({ accountId, credentials }: CatalogInput) {
    const oauth = (yield* credentials).type === "oauth";
    const getAccount = yield* accounts.getAccount;
    const listAccounts = yield* accounts.listAccounts;
    const listAccountPermissionGroups = yield* accounts.listTokensPermissionGroups;
    const listUserPermissionGroups = yield* user.listTokenPermissionGroups;
    const { accountList, groups } = yield* Effect.all(
      {
        accountList:
          accountId === undefined
            ? listAccounts({}).pipe(Effect.map(({ result }) => result))
            : getAccount({ accountId }).pipe(Effect.map(({ name }) => [{ id: accountId, name }])),
        groups:
          accountId === undefined
            ? listUserPermissionGroups({}).pipe(Effect.map(({ result }) => result))
            : listAccountPermissionGroups({ accountId }),
      },
      { concurrency: "unbounded" },
    );
    const ungrantable = (name?: string | null) =>
      oauth && !!name && OAUTH_UNGRANTABLE_PERMISSION_GROUPS.has(name);
    return {
      accounts: accountList.map(({ id, name }) => ({ id, name })),
      unavailablePermissionGroups: groups.flatMap(({ name }) => (ungrantable(name) ? [name!] : [])),
      permissionGroups: groups.flatMap((group) =>
        group.id && group.name && group.scopes?.length && !ungrantable(group.name)
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
    } satisfies TokenCatalog;
  },
  (effect, input) => withCredentials(input)(effect),
);

/** Resolve the selected permission groups into concrete token policies. */
export const plan = Effect.fn("Alchemist.cloudflare.token.plan")(function* (input: PlanInput) {
  const tokenCatalog = yield* catalog(input);
  const selected =
    input.permissionGroupIds === "all"
      ? tokenCatalog.permissionGroups
      : yield* Effect.forEach(input.permissionGroupIds, (id) => {
          const group = tokenCatalog.permissionGroups.find((candidate) => candidate.id === id);
          if (group === undefined) {
            return Effect.fail(
              new AlchemistInvalidInput({
                field: "permissionGroupIds",
                message: `Unknown Cloudflare permission group '${id}'.`,
              }),
            );
          }
          return Effect.succeed(group);
        });
  const userId =
    input.accountId === undefined
      ? (yield* user.getUser({}).pipe(withCredentials(input))).id
      : undefined;
  const resolved = tokenPolicies(input.accountIds, userId, selected);
  if (resolved.length === 0) {
    return yield* new AlchemistInvalidInput({
      field: "permissionGroupIds",
      message: "No selected permission groups can be expressed as token policies.",
    });
  }
  return {
    name: input.name,
    accountIds: input.accountIds,
    permissionGroupIds: selected.map(({ id }) => id),
    permissionCount: selected.length,
    grantsFullAccess: input.permissionGroupIds === "all",
    policies: resolved,
  } satisfies TokenPlan;
});

/** Mint the planned token. */
export const create = Effect.fn("Alchemist.cloudflare.token.create")(
  function* (input: CreateInput) {
    const { accountId } = input;
    const policies = input.plan.policies as TokenPolicy[];
    const result =
      accountId === undefined
        ? yield* user.createToken({ name: input.plan.name, policies })
        : yield* accounts.createToken({ accountId, name: input.plan.name, policies });
    if (!result.value) {
      return yield* new CloudflareTokenError({
        message: "Cloudflare did not return a token value.",
      });
    }
    const granted = (result.policies ?? []).reduce(
      (count, policy) => count + (policy.permissionGroups?.length ?? 0),
      0,
    );
    const verificationStatus = yield* Effect.gen(function* () {
      const { status } =
        accountId === undefined
          ? yield* user.verifyToken({})
          : yield* accounts.verifyToken({ accountId });
      return status ?? undefined;
    }).pipe(
      Effect.provideService(
        CloudflareCredentials.Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make(result.value) })),
      ),
      Effect.orElseSucceed(() => undefined),
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
                message: "Cloudflare created the token with zero permissions.",
              },
            ]
          : [],
    } satisfies CreatedToken;
  },
  (effect, input) => withCredentials(input)(effect),
);
