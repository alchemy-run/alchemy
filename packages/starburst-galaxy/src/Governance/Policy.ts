import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  GrantKindAndPrivilegesPrivilegeItem,
  Policy as PolicyShape,
  PolicyScope as PolicyScopeShape,
  PolicyScopeEntityKind,
} from "@distilled.cloud/starburst-galaxy/policy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  changedFields,
  collectAll,
  findFirst,
  GOVERNANCE_NAME,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

/** What a policy applies to, and what it allows, denies, filters or masks there. */
export interface PolicyScope {
  /** Kind of object: `Catalog`, `Schema`, `Table`, `Column`, `Cluster`, `Tag`, … */
  readonly entityKind: PolicyScopeEntityKind;
  /** ID of the object: a catalog ID for catalog, schema, table and column scopes. */
  readonly entityId: string;
  /** Schema inside the catalog; `"*"` for every schema. */
  readonly schemaName?: string;
  /** Table inside the schema; `"*"` for every table. */
  readonly tableName?: string;
  /** Column inside the table; `"*"` for every column. */
  readonly columnName?: string;
  /** Privileges the policy allows or denies on the object. */
  readonly privileges?: {
    readonly grantKind: "Allow" | "Deny";
    readonly privilege: ReadonlyArray<GrantKindAndPrivilegesPrivilegeItem>;
  };
  /** IDs of `RowFilter`s applied to matching tables. */
  readonly rowFilterIds?: ReadonlyArray<string>;
  /** IDs of `ColumnMask`s applied to matching columns. */
  readonly columnMaskIds?: ReadonlyArray<string>;
}

export interface PolicyProps {
  /**
   * Policy name. Renaming updates the policy in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited, at most 30 characters)
   */
  readonly name?: string;
  /**
   * ID of the role the policy applies to: users holding it get the
   * policy's privileges, filters and masks. Changing it replaces the policy.
   */
  readonly role: string;
  /**
   * Policy matching expression deciding whether the policy applies to a
   * query, e.g. `true`, or `has_tag("pii")` for tagged objects.
   */
  readonly predicate: string;
  /** What the policy applies to. */
  readonly scopes: ReadonlyArray<PolicyScope>;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /** When the policy stops applying (ISO 8601), e.g. `2027-01-01T00:00:00Z`. */
  readonly expiration?: string;
}

export interface PolicyAttributes {
  /** Galaxy's policy ID (`p-…`). */
  readonly policyId: string;
  /** Policy name. */
  readonly name: string;
  /** ID of the role the policy applies to. */
  readonly roleId: string;
  /** The matching expression. */
  readonly predicate: string;
  /** Description shown in Galaxy. */
  readonly description: string;
  /** When the policy stops applying, if set. */
  readonly expiration: string | undefined;
  /** The scopes as Galaxy stores them (a `Table` scope may be stored as its `Column` form). */
  readonly scopes: ReadonlyArray<PolicyScopeShape>;
  /** Creation time. */
  readonly created: string;
}

export type Policy = Resource<
  "StarburstGalaxy.Governance.Policy",
  PolicyProps,
  PolicyAttributes,
  never,
  Providers
>;

/**
 * A Starburst Galaxy access-control policy: for queries by users holding
 * `role` that match `predicate`, it allows or denies privileges on its
 * scopes and applies row filters and column masks to them.
 *
 * Name, predicate, description, expiration and scopes update in place;
 * the role replaces the policy. Galaxy stores some scopes in another form
 * than they were sent (a table scope for `Select` becomes a column scope
 * over every column), so scopes are sent whenever they change from the
 * last deploy rather than compared with what Galaxy reports.
 *
 * Policies have no labels or tags in Galaxy: a policy Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-data-access/creating-policies.html
 *
 * ### Granting through a policy
 * **Example:** Analysts may read every table of a catalog
 * ```typescript
 * const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
 * const sales = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "sales" });
 * yield* StarburstGalaxy.Governance.Policy("AnalystsRead", {
 *   role: analysts.roleId,
 *   predicate: "true",
 *   scopes: [
 *     {
 *       entityKind: "Column",
 *       entityId: sales.catalogId,
 *       schemaName: "*",
 *       tableName: "*",
 *       columnName: "*",
 *       privileges: { grantKind: "Allow", privilege: ["Select"] },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Filtering rows and masking columns
 * **Example:** EU analysts see EU rows, with emails hashed
 * ```typescript
 * const eu = yield* StarburstGalaxy.Role.Role("EuAnalysts", {});
 * const euOnly = yield* StarburstGalaxy.Governance.RowFilter("EuOnly", { expression: "region = 'EU'" });
 * const hashed = yield* StarburstGalaxy.Governance.ColumnMask("HashEmail", {
 *   expression: "to_hex(sha256(to_utf8(\"@column\")))",
 *   type: "Varchar",
 * });
 * const crm = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "crm" });
 * yield* StarburstGalaxy.Governance.Policy("EuCustomers", {
 *   role: eu.roleId,
 *   predicate: "true",
 *   scopes: [
 *     {
 *       entityKind: "Table",
 *       entityId: crm.catalogId,
 *       schemaName: "public",
 *       tableName: "customers",
 *       rowFilterIds: [euOnly.rowFilterId],
 *     },
 *     {
 *       entityKind: "Column",
 *       entityId: crm.catalogId,
 *       schemaName: "public",
 *       tableName: "customers",
 *       columnName: "email",
 *       columnMaskIds: [hashed.columnMaskId],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Access
 */
export const Policy = Resource<Policy>("StarburstGalaxy.Governance.Policy");

/** Galaxy accepted a policy create but the policy could not be read back. */
export class PolicyNotResolved extends Data.TaggedError("StarburstGalaxy.PolicyNotResolved")<{
  readonly policyName: string;
}> {
  override get message() {
    return `Policy ${this.policyName} could not be found after it was created`;
  }
}

const toAttributes = (policy: PolicyShape): PolicyAttributes => ({
  policyId: policy.policyId,
  name: policy.name,
  roleId: policy.roleId,
  predicate: policy.predicate,
  description: policy.description,
  expiration: policy.expiration,
  scopes: policy.scopes,
  created: policy.created,
});

const scopesOf = (scopes: ReadonlyArray<PolicyScope>): Array<PolicyScopeShape> =>
  scopes.map((scope) => ({
    entityKind: scope.entityKind,
    entityId: scope.entityId,
    schemaName: scope.schemaName,
    tableName: scope.tableName,
    columnName: scope.columnName,
    privileges:
      scope.privileges === undefined
        ? undefined
        : { grantKind: scope.privileges.grantKind, privilege: [...scope.privileges.privilege] },
    rowFilterIds: [...(scope.rowFilterIds ?? [])],
    columnMaskIds: [...(scope.columnMaskIds ?? [])],
  }));

const getPolicy = (policyId: string) =>
  galaxy.policy.getPolicy({ policyId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.policy.listPolicies.items({}), (policy) => policy.name === name);

const observe = Effect.fn(function* (policyId: string | undefined, name: string) {
  if (policyId !== undefined) {
    const byId = yield* getPolicy(policyId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyId", "roleId", "created"],

    nuke: {
      // Policies name roles, filters, masks and catalogs: they go first.
      dependsOn: [
        "StarburstGalaxy.Role.Role",
        "StarburstGalaxy.Governance.RowFilter",
        "StarburstGalaxy.Governance.ColumnMask",
        "StarburstGalaxy.Catalog.*",
      ],
    },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (news.role !== olds.role) {
        // An explicit name the replacement keeps must be freed first.
        const deleteFirst = news.name !== undefined && news.name === (output?.name ?? olds.name);
        return { action: "replace", deleteFirst } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, GOVERNANCE_NAME));
      const policy = yield* observe(output?.policyId, name);
      if (policy === undefined) return undefined;
      return ownership(toAttributes(policy), {
        output,
        explicitName: olds?.name,
        previous,
        key: "policyId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
      const name = yield* physicalName(id, news.name, GOVERNANCE_NAME);
      const scopes = scopesOf(news.scopes);

      // Observe
      let policy = yield* observe(output?.policyId, name);

      // Ensure: a create carries the whole desired state.
      let created = false;
      if (policy === undefined) {
        yield* session.note(`Creating policy ${name}...`);
        const fresh = yield* galaxy.policy
          .createPolicy({
            roleId: news.role,
            name,
            predicate: news.predicate,
            description: news.description ?? "",
            expiration: news.expiration,
            scopes,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        created = fresh !== undefined;
        policy = fresh ?? (yield* findByName(name));
      }
      if (policy === undefined) {
        return yield* new PolicyNotResolved({ policyName: name });
      }

      // Sync: scalar fields against what Galaxy reports; scopes against the
      // last deploy (Galaxy normalizes them), and always on adoption.
      if (!created) {
        const delta = changedFields(policy, {
          name,
          predicate: news.predicate,
          description: news.description ?? "",
          expiration: news.expiration,
        });
        const scopesChanged = olds === undefined || !deepEqual(scopesOf(olds.scopes), scopes);
        if (hasChanges(delta) || scopesChanged) {
          yield* session.note(`Updating policy ${name}...`);
          policy = yield* galaxy.policy.updatePolicy({
            ...delta,
            ...(scopesChanged ? { scopes } : {}),
            policyId: policy.policyId,
          });
        }
      }

      return toAttributes(policy);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.policy
        .deletePolicy({ policyId: output.policyId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.policy.listPolicies
          .items({})
          .pipe(Stream.filter((item) => isGeneratedName(item.name))),
        toAttributes,
      ),
  });
