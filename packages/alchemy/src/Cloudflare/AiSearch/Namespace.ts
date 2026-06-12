import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const AiSearchNamespaceTypeId = "Cloudflare.AiSearch.Namespace" as const;
type AiSearchNamespaceTypeId = typeof AiSearchNamespaceTypeId;

export type AiSearchNamespaceProps = {
  /**
   * Namespace name. Lowercase letters, digits, and hyphens; must start and
   * end with an alphanumeric character; 1-28 characters. The name is the
   * namespace's identity (it appears in the API path) and cannot be
   * renamed — changing it triggers a replacement. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Optional human-readable description for the namespace.
   * Max 256 characters.
   */
  description?: string;
};

export type AiSearchNamespaceAttributes = {
  /**
   * Namespace name (its identity within the account).
   */
  name: string;
  /**
   * The Cloudflare account the namespace belongs to.
   */
  accountId: string;
  /**
   * Human-readable description, when set.
   */
  description: string | undefined;
  /**
   * When the namespace was created.
   */
  createdAt: string | undefined;
};

export type AiSearchNamespace = Resource<
  AiSearchNamespaceTypeId,
  AiSearchNamespaceProps,
  AiSearchNamespaceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare AI Search namespace — a logical grouping for AI Search
 * instances within an account.
 *
 * Namespaces partition AI Search (formerly AutoRAG) instances: each
 * namespace owns its own set of namespace-scoped instances and can be
 * searched or queried as a unit. The namespace `name` is its identity —
 * changing it triggers a replacement; only the `description` is mutable
 * in place.
 *
 * @section Creating a Namespace
 * @example Generated name
 * ```typescript
 * const ns = yield* Cloudflare.AiSearchNamespace("docs", {});
 * ```
 *
 * @example Explicit name and description
 * ```typescript
 * const ns = yield* Cloudflare.AiSearchNamespace("docs", {
 *   name: "docs-search",
 *   description: "Search over the product documentation",
 * });
 * ```
 *
 * @section Updating a Namespace
 * @example Change the description in place
 * ```typescript
 * const ns = yield* Cloudflare.AiSearchNamespace("docs", {
 *   name: "docs-search",
 *   description: "Search over docs and changelogs",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const AiSearchNamespace = Resource<AiSearchNamespace>(
  AiSearchNamespaceTypeId,
);

/**
 * Returns true if the given value is an AiSearchNamespace resource.
 */
export const isAiSearchNamespace = (
  value: unknown,
): value is AiSearchNamespace =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === AiSearchNamespaceTypeId;

export const AiSearchNamespaceProvider = () =>
  Provider.succeed(AiSearchNamespace, {
    stables: ["name", "accountId", "createdAt"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The name is the namespace's identity (it is the API path
      // parameter) — renaming is a replacement.
      const newName = yield* createNamespaceName(id, news.name);
      const oldName =
        output?.name ?? (yield* createNamespaceName(id, olds.name));
      if (newName !== oldName) {
        // A user-pinned name collides with the still-existing old
        // namespace only when both resolve to the same string — they
        // don't here, so create-before-delete is safe.
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The name is deterministic (explicit prop or generated from the
      // logical id), so a cold read (lost state) resolves the same
      // identifier as the original create did.
      const name = output?.name ?? (yield* createNamespaceName(id, olds?.name));
      const observed = yield* getNamespace(acct, name);
      return observed ? toAttributes(observed, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const name = output?.name ?? (yield* createNamespaceName(id, news.name));

      // Observe — `output.name` is a cache, not a guarantee: a missing
      // namespace falls through to create.
      let observed = yield* getNamespace(acct, name);

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). A concurrent
        // create surfaces as `NamespaceAlreadyExists` — treat it as a
        // race and fall through to the sync path against the observed
        // namespace.
        const ensured = yield* aisearch
          .createNamespace({
            accountId: acct,
            name,
            description: news.description,
          })
          .pipe(
            Effect.map((created) => ({ created: true as const, ns: created })),
            Effect.catchTag("NamespaceAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const existing = yield* getNamespace(acct, name);
                if (!existing) return yield* Effect.fail(originalError);
                return { created: false as const, ns: existing };
              }),
            ),
          );
        if (ensured.created) {
          return toAttributes(ensured.ns, acct);
        }
        observed = ensured.ns;
      }

      // Sync — the description is the only mutable aspect. Diff observed
      // cloud state against desired; skip the PUT entirely on a no-op.
      const observedDescription = normalize(observed.description);
      if (observedDescription === news.description) {
        return toAttributes(observed, acct);
      }
      const updated = yield* aisearch
        .updateNamespace({
          accountId: acct,
          name,
          // `null` clears a previously-set description.
          description: news.description ?? null,
        })
        .pipe(
          // The observe read can be eventually consistent: a namespace
          // deleted out-of-band may still appear in `readNamespace` and
          // then 404 here. Treat that as "missing" and recreate with the
          // desired shape.
          Effect.catchTag("NamespaceNotFound", () =>
            aisearch.createNamespace({
              accountId: acct,
              name,
              description: news.description,
            }),
          ),
        );
      return toAttributes(updated, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // A missing namespace (already deleted) is success. Instances inside
      // the namespace must be deleted first — the engine orders that via
      // the `namespace` reference on dependent resources.
      yield* aisearch
        .deleteNamespace({ accountId: output.accountId, name: output.name })
        .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));
    }),
  });

type ObservedNamespace = aisearch.ReadNamespaceResponse;

/**
 * Read a namespace by name, mapping "gone" (`NamespaceNotFound`,
 * Cloudflare error code 7063) to `undefined`.
 */
const getNamespace = (accountId: string, name: string) =>
  aisearch
    .readNamespace({ accountId, name })
    .pipe(
      Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
    );

const createNamespaceName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    // Cloudflare restricts namespace names to lowercase alphanumerics and
    // hyphens, 1-28 characters.
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 28 }))
    );
  });

/**
 * Cloudflare returns `null` for an unset description; desired-state
 * shapes leave it `undefined`. Collapse both to `undefined` for diffing.
 */
const normalize = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

const toAttributes = (
  ns:
    | ObservedNamespace
    | aisearch.CreateNamespaceResponse
    | aisearch.UpdateNamespaceResponse,
  accountId: string,
): AiSearchNamespaceAttributes => ({
  name: ns.name,
  accountId,
  description: normalize(ns.description),
  createdAt: ns.createdAt,
});
