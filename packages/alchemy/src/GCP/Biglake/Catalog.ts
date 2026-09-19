import * as biglake from "@distilled.cloud/gcp/biglake_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  BiglakeNotResolved,
  DEFAULT_LOCATION,
  MAX_ID_LENGTH,
  createInternalLabels,
  hasAlchemyLabels,
  hasOwnershipMarker,
  ignoreGone,
  listCatalogs,
  listDatabases,
  listTables,
  locationParent,
  missingGet,
  namedOf,
  normalizeLocation,
  ownershipMarker,
  parseOwnershipMarker,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  rfc1035,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";

export type CatalogProps = {
  /**
   * Catalog id (the `{catalog}` segment of
   * `projects/{project}/locations/{location}/catalogs/{catalog}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the catalog.
   */
  catalogId?: string;
  /**
   * Location (`us-central1`, `US`, …). Immutable — changing it replaces
   * the catalog. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
};

export type Catalog = Resource<
  "GCP.Biglake.Catalog",
  CatalogProps,
  {
    /** Full resource name. */
    name: string;
    /** Catalog id (last path segment). */
    catalogId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 deletion timestamp, if the catalog is soft-deleted. */
    deleteTime: string | undefined;
    /** RFC3339 expire timestamp after delete. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigLake Metastore catalog — the top-level container for Hive
 * databases and tables.
 *
 * Catalogs have no labels, description, or annotations. Alchemy stamps
 * ownership into the catalog IAM policy so `list` / nuke can find them.
 * Location and catalog id are immutable. There is nothing else to
 * update in place.
 *
 * ### Creating a Catalog
 * **Example:** Generated id
 * ```typescript
 * const catalog = yield* GCP.Biglake.Catalog("Lake", {});
 * ```
 *
 * **Example:** Named catalog in a multi-region
 * ```typescript
 * const catalog = yield* GCP.Biglake.Catalog("Lake", {
 *   catalogId: "analytics",
 *   location: "US",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Biglake
 */
export const Catalog = Resource<Catalog>("GCP.Biglake.Catalog");

const OWNERSHIP_ROLE = "roles/bigquery.metadataViewer";
const OWNERSHIP_TITLE = "alchemy-ownership";
const OWNERSHIP_EXPRESSION = 'request.time < timestamp("2000-01-01T00:00:00Z")';

const resourceName = (project: string, location: string, catalogId: string) =>
  `${locationParent(project, location)}/catalogs/${catalogId}`;

const toAttrs = (catalog: biglake.Catalog, project: string) => {
  const name = catalog.name ?? "";
  const parsed = parseResourceName(name, "catalogs");
  return {
    name,
    catalogId: parsed.id,
    project,
    location: parsed.location,
    createTime: catalog.createTime,
    updateTime: catalog.updateTime,
    deleteTime: catalog.deleteTime,
    expireTime: catalog.expireTime,
  };
};

const getByName = missingGet(biglake.getProjectsLocationsCatalogs);

const ownershipMember = (project: string) =>
  `serviceAccount:alchemy-ownership@${project}.iam.gserviceaccount.com`;

const policyHasOwnership = (policy: biglake.Policy | undefined) =>
  (policy?.bindings ?? []).some(
    (binding) =>
      binding.condition?.title === OWNERSHIP_TITLE ||
      hasOwnershipMarker(binding.condition?.description),
  );

const getPolicy = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : biglake
        .getIamPolicyProjectsCatalogs({
          resource: name,
          "options.requestedPolicyVersion": 3,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
          Effect.catchTag("UnknownGCPError", () => Effect.succeed(undefined)),
        );

const toCatalogId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* toPhysicalId(id, undefined, undefined);
    if (generated.startsWith("alc_")) return generated;
    return rfc1035(`alc_${generated}`, MAX_ID_LENGTH);
  });

const stampOwnership = Effect.fn(function* (
  name: string,
  project: string,
  labels: Record<string, string>,
) {
  const policy = yield* getPolicy(name);
  if (policyHasOwnership(policy)) return;
  const marker = ownershipMarker(labels);
  const bindings = [...(policy?.bindings ?? [])];
  const existing = bindings.findIndex(
    (binding) => binding.condition?.title === OWNERSHIP_TITLE,
  );
  const stamped: biglake.Binding = {
    role: OWNERSHIP_ROLE,
    members: [ownershipMember(project)],
    condition: {
      title: OWNERSHIP_TITLE,
      description: marker,
      expression: OWNERSHIP_EXPRESSION,
    },
  };
  if (existing >= 0) bindings[existing] = stamped;
  else bindings.push(stamped);
  yield* retryTransient(
    biglake.setIamPolicyProjectsCatalogs({
      resource: name,
      body: {
        policy: {
          etag: policy?.etag,
          version: 3,
          bindings,
          auditConfigs: policy?.auditConfigs,
        },
      },
    }),
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
    Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
    Effect.catchTag("UnknownGCPError", () => Effect.succeed(undefined)),
  );
});

const lastIdOwned = (name: string | undefined) => {
  const id = parseResourceName(name ?? "", "catalogs").id;
  return id.startsWith("alc_");
};

const isOwnedCatalog = (catalog: biglake.Catalog, policy?: biglake.Policy) =>
  policyHasOwnership(policy) || lastIdOwned(catalog.name);

const ownedFromPolicy = (id: string, policy: biglake.Policy | undefined) =>
  Effect.gen(function* () {
    for (const binding of policy?.bindings ?? []) {
      const labels = parseOwnershipMarker(binding.condition?.description);
      if (yield* hasAlchemyLabels(id, labels)) return true;
    }
    return false;
  });

const emptyCatalog = (name: string) =>
  Effect.gen(function* () {
    const databases = yield* listDatabases(name);
    yield* Effect.forEach(
      namedOf(databases),
      (database) => emptyAndDeleteDatabase(database.name!),
      { concurrency: 1 },
    );
  });

const emptyAndDeleteDatabase = (name: string) =>
  Effect.gen(function* () {
    const tables = yield* listTables(name);
    yield* Effect.forEach(
      namedOf(tables),
      (table) =>
        ignoreGone(
          biglake.deleteProjectsLocationsCatalogsDatabasesTables({
            name: table.name!,
          }),
        ),
      { concurrency: 4 },
    );
    yield* ignoreGone(
      biglake.deleteProjectsLocationsCatalogsDatabases({ name }),
    );
  });

export const CatalogProvider = () =>
  Provider.succeed(Catalog, {
    stables: ["name", "catalogId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.catalogId ?? output?.catalogId,
        nextId: news.catalogId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const catalogId = yield* toCatalogId(
        id,
        olds?.catalogId,
        output?.catalogId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, catalogId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const policy = yield* getPolicy(existing.name ?? name);
      const labeled = yield* ownedFromPolicy(id, policy);
      return labeled || isOwnedCatalog(existing, policy)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const catalogs = yield* listCatalogs(
          locationParent(env.project, DEFAULT_LOCATION),
        );
        const owned = yield* Effect.forEach(
          namedOf(catalogs),
          (catalog) =>
            Effect.gen(function* () {
              const policy = yield* getPolicy(catalog.name!);
              return isOwnedCatalog(catalog, policy) ? catalog : undefined;
            }),
          { concurrency: 4 },
        );
        return owned
          .filter((item): item is biglake.Catalog => item !== undefined)
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const catalogId = yield* toCatalogId(
        id,
        news.catalogId,
        output?.catalogId,
      );
      const parent = locationParent(env.project, location);
      const name =
        output?.name ?? resourceName(env.project, location, catalogId);
      const ownership = yield* createInternalLabels(id);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          biglake.createProjectsLocationsCatalogs({
            parent,
            catalogId,
            body: {},
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BiglakeNotResolved({ name });
      }

      yield* stampOwnership(current.name ?? name, env.project, ownership);
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* emptyCatalog(output.name);
      yield* ignoreGone(
        biglake.deleteProjectsLocationsCatalogs({ name: output.name }),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
