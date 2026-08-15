import * as globalConfig from "@distilled.cloud/vercel/global_config";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { stableStringify } from "../../Util/stable.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

export interface EdgeConfigProps {
  /**
   * Slug (name) of the Edge Config. If omitted, a unique slug is generated
   * from the app, stage, and logical ID. Must start with an alphabetic
   * character and contain only alphanumeric characters, underscores, and
   * hyphens (max 64 characters). Renaming is applied in place (no
   * replacement) — Edge Config slugs are not unique identifiers.
   */
  slug?: string;
  /**
   * Declarative item set for the Edge Config. When set, the provider
   * converges the config's items to exactly this map — adding, updating,
   * and removing items as needed (drift written out-of-band is reverted on
   * the next deploy). When omitted, items are left unmanaged.
   *
   * Values may be any JSON value (string, number, boolean, null, object,
   * array).
   */
  items?: Record<string, unknown>;
  /**
   * Optional JSON Schema enforced by Vercel on item writes. When set, the
   * provider keeps the config's schema in sync with this definition. When
   * omitted after previously being set, the schema is deleted.
   */
  schema?: Record<string, unknown>;
}

export interface EdgeConfig extends Resource<
  "Vercel.EdgeConfig",
  EdgeConfigProps,
  {
    /**
     * Unique ID of the Edge Config (e.g. `ecfg_…`). Used in the data-plane
     * connection string `https://edge-config.vercel.com/{edgeConfigId}`.
     */
    edgeConfigId: string;
    /**
     * Slug (name) of the Edge Config.
     */
    slug: string;
    /**
     * Content digest — changes whenever the items change.
     */
    digest: string;
    /**
     * Creation timestamp (ms since epoch).
     */
    createdAt: number;
    /**
     * ID of the owning team or user.
     */
    ownerId: string;
    /**
     * Number of items currently stored.
     */
    itemCount: number;
    /**
     * Total size of the stored items in bytes.
     */
    sizeInBytes: number;
  },
  never,
  Providers
> {}

type EdgeConfigAttributes = EdgeConfig["Attributes"];

/**
 * A Vercel Edge Config (Global Config) — an ultra-low-latency key-value
 * store replicated to Vercel's edge network, ideal for feature flags,
 * A/B testing configuration, and dynamic redirects.
 *
 * Items declared on the resource are managed declaratively: the provider
 * diffs the observed items against the declared map on every deploy and
 * applies only the delta, so out-of-band drift converges back to the
 * declared state. Reads at runtime go through the data plane
 * (`https://edge-config.vercel.com/{edgeConfigId}`) with a read token
 * minted via the Vercel API.
 * @resource
 * @section Creating an Edge Config
 * @example Basic Edge Config
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 *
 * const flags = yield* Vercel.EdgeConfig("flags", {});
 * ```
 *
 * @example Edge Config with declarative items
 * ```typescript
 * const flags = yield* Vercel.EdgeConfig("flags", {
 *   items: {
 *     enableCheckout: true,
 *     bannerText: "Hello!",
 *     limits: { maxItems: 10 },
 *   },
 * });
 * ```
 *
 * @example Edge Config with an explicit slug
 * ```typescript
 * const flags = yield* Vercel.EdgeConfig("flags", {
 *   slug: "my_feature_flags",
 * });
 * ```
 *
 * @section Enforcing a schema
 * @example Validate items with JSON Schema
 * ```typescript
 * const flags = yield* Vercel.EdgeConfig("flags", {
 *   schema: {
 *     type: "object",
 *     properties: {
 *       enableCheckout: { type: "boolean" },
 *     },
 *   },
 *   items: { enableCheckout: false },
 * });
 * ```
 *
 * @see https://vercel.com/docs/edge-config
 */
export const EdgeConfig = Resource<EdgeConfig>("Vercel.EdgeConfig");

export const EdgeConfigProvider = () =>
  Provider.succeed(EdgeConfig, {
    stables: ["edgeConfigId", "createdAt", "ownerId"],
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      const configs = yield* globalConfig.getEdgeConfigs({ teamId });
      return configs.map(toEdgeConfigAttributes);
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Owned path: refresh by the persisted Edge Config id.
      if (output?.edgeConfigId) {
        return yield* globalConfig
          .getEdgeConfig({ edgeConfigId: output.edgeConfigId, teamId })
          .pipe(
            Effect.map(toEdgeConfigAttributes),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
      }

      // Cold read: no persisted id (state-persistence failure). Match on
      // slug via the list API. Edge Configs carry no ownership markers
      // (no tags, no env), so we cannot prove we created a match — brand
      // it `Unowned` so the engine gates takeover behind adoption.
      const slug = yield* createSlug(id, olds?.slug);
      const configs = yield* globalConfig.getEdgeConfigs({ teamId });
      const match = configs.find((c) => c.slug === slug);
      if (match) return Unowned(toEdgeConfigAttributes(match));
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, olds, output, session }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Auto-generated slugs are engine-owned: prefer the deployed slug so
      // generator drift never renames an existing config. Only an explicit
      // `news.slug` forces a rename.
      const desiredSlug =
        news.slug ?? output?.slug ?? (yield* createSlug(id, undefined));

      // 1. Observe — the cached id is a hint, not a guarantee.
      let observed = output?.edgeConfigId
        ? yield* globalConfig
            .getEdgeConfig({ edgeConfigId: output.edgeConfigId, teamId })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)))
        : undefined;

      // 2. Ensure — create when missing. Slugs are not unique on Vercel, so
      //    there is no AlreadyExists race to tolerate; the API happily
      //    creates and returns the new config.
      if (observed === undefined) {
        const created = yield* globalConfig.createEdgeConfig({
          slug: desiredSlug,
          teamId,
        });
        yield* session.note(`Created Edge Config: ${created.slug}`);
        observed = yield* globalConfig.getEdgeConfig({
          edgeConfigId: created.id,
          teamId,
        });
      }
      const edgeConfigId = observed.id;

      // 3. Sync slug — rename in place when the observed slug differs.
      if (observed.slug !== desiredSlug) {
        yield* globalConfig.updateEdgeConfig({
          edgeConfigId,
          slug: desiredSlug,
          teamId,
        });
        yield* session.note(
          `Renamed Edge Config: ${observed.slug} -> ${desiredSlug}`,
        );
      }

      // 4. Sync schema before items so item writes validate against the
      //    declared schema. Observed baseline comes from the schema
      //    endpoint (adoption-safe); `olds` is only a hint that we
      //    previously managed a schema and should delete it when
      //    undeclared.
      yield* syncSchema({
        edgeConfigId,
        teamId,
        desired: news.schema,
        oldsHadSchema: olds?.schema !== undefined,
        session,
      });

      // 5. Sync items — diff observed (management API, strongly
      //    consistent) against the declared map and apply only the delta.
      yield* syncItems({
        edgeConfigId,
        teamId,
        desired: news.items,
        session,
      });

      // 6. Return fresh attributes (digest/counters reflect the syncs).
      const final = yield* globalConfig.getEdgeConfig({ edgeConfigId, teamId });
      return toEdgeConfigAttributes(final);
    }),
    delete: Effect.fn(function* ({ output, session }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* globalConfig
        .deleteEdgeConfig({ edgeConfigId: output.edgeConfigId, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* session.note(`Deleted Edge Config: ${output.slug}`);
    }),
  });

const createSlug = (id: string, slug: string | undefined) =>
  Effect.gen(function* () {
    // Edge Config slugs allow [A-Za-z0-9_-] and max 64 chars; the physical
    // name generator's alphanumeric+hyphen output fits.
    return slug ?? (yield* createPhysicalName({ id, maxLength: 64 }));
  });

const toEdgeConfigAttributes = (config: {
  id: string;
  slug: string;
  digest: string;
  createdAt: number;
  ownerId: string;
  itemCount: number;
  sizeInBytes: number;
}): EdgeConfigAttributes => ({
  edgeConfigId: config.id,
  slug: config.slug,
  digest: config.digest,
  createdAt: config.createdAt,
  ownerId: config.ownerId,
  itemCount: config.itemCount,
  sizeInBytes: config.sizeInBytes,
});

/**
 * Read the currently-stored schema definition. The endpoint answers
 * `{ definition: … }` when a schema is set and an empty 204 (decoded as
 * `{}`) when none is — both collapse into `definition | undefined`.
 */
const observeSchema = (edgeConfigId: string, teamId: string | undefined) =>
  globalConfig.getEdgeConfigSchema({ edgeConfigId, teamId }).pipe(
    Effect.map((response) =>
      typeof response === "object" &&
      response !== null &&
      "definition" in response
        ? (response as { definition: unknown }).definition
        : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const syncSchema = Effect.fn(function* ({
  edgeConfigId,
  teamId,
  desired,
  oldsHadSchema,
  session,
}: {
  edgeConfigId: string;
  teamId: string | undefined;
  desired: Record<string, unknown> | undefined;
  oldsHadSchema: boolean;
  session: ScopedPlanStatusSession;
}) {
  const observedSchema = yield* observeSchema(edgeConfigId, teamId);
  if (desired !== undefined) {
    if (stableStringify(observedSchema) === stableStringify(desired)) return;
    yield* globalConfig.patchEdgeConfigSchema({
      edgeConfigId,
      teamId,
      definition: desired,
    });
    yield* session.note(`Updated Edge Config schema: ${edgeConfigId}`);
    return;
  }
  // Undeclared: only delete a schema we previously declared ourselves —
  // an adopted config's foreign schema is left untouched.
  if (oldsHadSchema && observedSchema !== undefined) {
    yield* globalConfig
      .deleteEdgeConfigSchema({ edgeConfigId, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* session.note(`Removed Edge Config schema: ${edgeConfigId}`);
  }
});

const syncItems = Effect.fn(function* ({
  edgeConfigId,
  teamId,
  desired,
  session,
}: {
  edgeConfigId: string;
  teamId: string | undefined;
  desired: Record<string, unknown> | undefined;
  session: ScopedPlanStatusSession;
}) {
  // Items undeclared — leave whatever is stored unmanaged.
  if (desired === undefined) return;

  // Observe via the management API (strongly consistent, unlike the
  // eventually-consistent data plane).
  const observed = yield* globalConfig.getEdgeConfigItems({
    edgeConfigId,
    teamId,
  });
  const observedByKey = new Map(observed.map((item) => [item.key, item.value]));

  const ops: globalConfig.PatchEdgeConfigItemsRequestItemsItem[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const current = observedByKey.get(key);
    if (
      !observedByKey.has(key) ||
      stableStringify(current) !== stableStringify(value)
    ) {
      ops.push({ operation: "upsert", key, value });
    }
  }
  for (const key of observedByKey.keys()) {
    if (!(key in desired) || desired[key] === undefined) {
      ops.push({ operation: "delete", key });
    }
  }

  if (ops.length === 0) return;
  yield* globalConfig.patchEdgeConfigItems({
    edgeConfigId,
    teamId,
    items: ops,
  });
  yield* session.note(
    `Synced ${ops.length} Edge Config item(s): ${edgeConfigId}`,
  );
});
