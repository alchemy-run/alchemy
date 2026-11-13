import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Validate } from "@distilled.cloud/starburst-galaxy/catalog";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  CATALOG_NAME,
  collectAll,
  findFirst,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";

/**
 * The plain value of an optional secret prop, for comparing the deployed
 * value with a new one. Never logged or stored.
 */
export const secretValue = (secret: Redacted.Redacted<string> | undefined) =>
  secret === undefined ? undefined : Redacted.value(secret);

/** The cloud a database runs in, for Galaxy's network routing. */
export type CloudKind = "AWS" | "AZURE" | "GCP";

/** Find a catalog this stack doesn't manage by its name. */
export interface CatalogLookup {
  /** Catalog name (unique across every kind in the account). */
  readonly name: string;
}

const CATALOG_STABLES: Array<"catalogId"> = ["catalogId"];

/** Props every Galaxy catalog kind accepts. */
export interface CatalogBaseProps {
  /**
   * Catalog name in Galaxy and in SQL (`SELECT … FROM <name>.<schema>.<table>`).
   * Renaming updates the catalog in place; queries that name the old catalog stop working.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /**
   * Description shown in Galaxy's catalog list.
   * @default ""
   */
  readonly description?: string;
  /**
   * Refuse writes (`INSERT`, `CREATE TABLE`, …) through this catalog.
   * @default false
   */
  readonly readOnly?: boolean;
  /**
   * Have Galaxy connect with the given settings on every create and update,
   * and check the stored catalog with Galaxy's validation after each deploy.
   * A catalog that fails the check fails the deploy with
   * `StarburstGalaxy.Catalog.CatalogValidationFailed`, and stays in Galaxy so a fixed
   * configuration updates it in place.
   * @default true
   */
  readonly validate?: boolean;
}

/** Attributes every Galaxy catalog kind reports. */
export interface CatalogBaseAttributes {
  /** Galaxy's catalog ID (`c-…`). Attach it to a cluster with `Cluster`'s `catalogs`. */
  readonly catalogId: string;
  /** Catalog name in Galaxy and in SQL. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** Whether writes through the catalog are refused. */
  readonly readOnly: boolean;
}

/** What every Galaxy catalog response carries, whatever its kind. */
export interface CatalogShape {
  readonly catalogId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly readOnly: boolean;
}

/**
 * Galaxy's validation of a catalog's connection failed. `errors`,
 * `warnings` and `info` are Galaxy's own messages.
 */
export class CatalogValidationFailed extends Data.TaggedError(
  "StarburstGalaxy.CatalogValidationFailed",
)<{
  readonly kind: string;
  readonly catalogName: string;
  readonly catalogId: string;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly info: ReadonlyArray<string>;
}> {
  override get message() {
    return `${this.kind} catalog "${this.catalogName}" (${this.catalogId}) failed validation: ${this.errors.join("; ") || "no reason given"}`;
  }
}

/**
 * A catalog with the requested name exists in Galaxy, but it is another
 * kind of catalog. Catalog names are unique across kinds, so pick another
 * `name`.
 */
export class CatalogNameTaken extends Data.TaggedError("StarburstGalaxy.CatalogNameTaken")<{
  readonly kind: string;
  readonly catalogName: string;
  readonly catalogId: string;
}> {
  override get message() {
    return `A catalog named "${this.catalogName}" (${this.catalogId}) already exists and is not a ${this.kind} catalog`;
  }
}

/** Galaxy accepted a catalog create but the catalog could not be read back. */
export class CatalogNotResolved extends Data.TaggedError("StarburstGalaxy.CatalogNotResolved")<{
  readonly kind: string;
  readonly catalogName: string;
}> {
  override get message() {
    return `${this.kind} catalog "${this.catalogName}" could not be found after it was created`;
  }
}

type Op<A, E> = Effect.Effect<A, E, galaxy.StarburstGalaxyOpContext>;

/**
 * One catalog kind: its distilled operations and the pure mappings between
 * the resource's props and Galaxy's request and response shapes. The
 * lifecycle in {@link catalogLifecycle} is shared by every kind.
 */
export interface CatalogKind<
  Props extends CatalogBaseProps,
  Shape extends CatalogShape,
  Attrs extends CatalogBaseAttributes,
  Create,
  Patch,
  E,
> {
  /** Galaxy's name for the kind, for messages: `"PostgreSQL"`. */
  readonly kind: string;
  /** `get<Kind>Catalog`; `undefined` when Galaxy reports `NotFound`. */
  readonly get: (catalogId: string) => Op<Shape | undefined, E>;
  /** `create<Kind>Catalog`; `undefined` when the name is taken (`Conflict`). */
  readonly create: (request: Create) => Op<Shape | undefined, E>;
  /** `update<Kind>Catalog` (PATCH: only the fields present change). */
  readonly update: (catalogId: string, patch: Patch) => Op<Shape, E>;
  /** `validate<Kind>Catalog`: `GET …/catalog/{id}/validate` on a stored catalog. */
  readonly validate: (catalogId: string) => Op<Validate, E>;
  /** `delete<Kind>Catalog`; succeeds when Galaxy reports `NotFound`. */
  readonly delete: (catalogId: string) => Op<void, E>;
  /** `list<Kind>Catalogs`, every page. */
  readonly list: Stream.Stream<Shape, E, galaxy.StarburstGalaxyOpContext>;
  /** The create request for `props` under the physical `name`. */
  readonly toCreate: (name: string, props: Props) => Create;
  /**
   * The PATCH that moves `observed` to `props` under `name`, or `undefined`
   * when nothing differs. Galaxy never returns secrets, so they are sent
   * only when `withSecrets` is set: their prop changed, or the catalog was
   * adopted and their stored value is unknown.
   */
  readonly toPatch: (
    name: string,
    props: Props,
    observed: Shape,
    withSecrets: boolean,
  ) => Patch | undefined;
  /** The resource's attributes; never carries a secret. */
  readonly toAttributes: (shape: Shape) => Attrs;
  /** Whether a secret prop's value changed (compared by value, never logged). */
  readonly secretsChanged: (olds: Props, news: Props) => boolean;
  /** Whether the change cannot be applied in place and replaces the catalog. */
  readonly replaces?: (olds: Props, news: Props) => boolean;
}

/**
 * The provider lifecycle every Galaxy catalog kind shares: observe by id,
 * else by name across all kinds; create or PATCH the delta; check the
 * stored catalog with Galaxy's validation; delete; list.
 *
 * Catalogs carry no labels or tags, so ownership rests on the generated
 * name (see `ownership` in `internal.ts`). Catalog writes are synchronous:
 * there is no state to wait on.
 */
export const catalogLifecycle = <
  Props extends CatalogBaseProps,
  Shape extends CatalogShape,
  Attrs extends CatalogBaseAttributes,
  Create,
  Patch,
  E,
>(
  def: CatalogKind<Props, Shape, Attrs, Create, Patch, E>,
) => {
  /**
   * By id when one is known, else by name. `listCatalogs` covers every
   * kind, so a same-named catalog of another kind fails with
   * {@link CatalogNameTaken} instead of being created over.
   */
  const observe = Effect.fn(function* (catalogId: string | undefined, name: string) {
    if (catalogId !== undefined) {
      const byId = yield* def.get(catalogId);
      if (byId !== undefined) return byId;
    }
    const listed = yield* findFirst(
      galaxy.catalog.listCatalogs.items({}),
      (catalog) => catalog.catalogName === name,
    );
    if (listed === undefined) return undefined;
    const shape = yield* def.get(listed.catalogId);
    if (shape === undefined) {
      return yield* new CatalogNameTaken({
        kind: def.kind,
        catalogName: name,
        catalogId: listed.catalogId,
      });
    }
    return shape;
  });

  /** Galaxy's own check of the stored catalog, after the write. */
  const validated = Effect.fn(function* (shape: Shape, props: Props) {
    if (props.validate === false) return;
    const result = yield* def.validate(shape.catalogId);
    if (!result.validationSuccessful) {
      return yield* new CatalogValidationFailed({
        kind: def.kind,
        catalogName: shape.name,
        catalogId: shape.catalogId,
        errors: result.errorMessages,
        warnings: result.warningMessages,
        info: result.infoMessages,
      });
    }
  });

  return {
    stables: CATALOG_STABLES,

    diff: Effect.fn(function* ({
      news,
      olds,
      output,
    }: {
      readonly news: Input<Props>;
      readonly olds: Props;
      readonly output: Attrs | undefined;
    }) {
      if (!isResolved(news)) return undefined;
      if (def.replaces?.(olds, news)) {
        // An explicit name the replacement keeps must be freed first.
        const deleteFirst = news.name !== undefined && news.name === (output?.name ?? olds.name);
        return { action: "replace", deleteFirst } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      id,
      olds,
      output,
      previous,
    }: {
      readonly id: string;
      readonly olds: Props | undefined;
      readonly output: Attrs | undefined;
      readonly previous?: Attrs | undefined;
    }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, CATALOG_NAME));
      const shape = yield* observe(output?.catalogId, name);
      if (shape === undefined) return undefined;
      return ownership(def.toAttributes(shape), {
        output,
        explicitName: olds?.name,
        previous,
        key: "catalogId",
      });
    }),

    lookup: Effect.fn(function* ({ name }: { readonly name: string }) {
      const shape = yield* observe(undefined, name);
      return shape === undefined ? undefined : def.toAttributes(shape);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      olds,
      output,
      session,
    }: {
      readonly id: string;
      readonly news: Props;
      readonly olds: Props | undefined;
      readonly output: Attrs | undefined;
      readonly session: ScopedPlanStatusSession;
    }) {
      const name = yield* physicalName(id, news.name, CATALOG_NAME);

      // Observe: by id when known, else by the name (absorbs a lost create).
      let shape = yield* observe(output?.catalogId, name);

      // Ensure: a create carries the whole desired state.
      let created = false;
      if (shape === undefined) {
        yield* session.note(`Creating ${def.kind} catalog ${name}...`);
        const fresh = yield* def.create(def.toCreate(name, news));
        created = fresh !== undefined;
        // `Conflict`: created concurrently or by a lost attempt; take it over by name.
        shape = fresh ?? (yield* observe(undefined, name));
      }
      if (shape === undefined) {
        return yield* new CatalogNotResolved({ kind: def.kind, catalogName: name });
      }

      // Sync: PATCH only what differs from what Galaxy reports, the rename included.
      if (!created) {
        const withSecrets = olds === undefined || def.secretsChanged(olds, news);
        const patch = def.toPatch(name, news, shape, withSecrets);
        if (patch !== undefined) {
          yield* session.note(`Updating ${def.kind} catalog ${name}...`);
          shape = yield* def.update(shape.catalogId, patch);
        }
      }

      yield* validated(shape, news);
      return def.toAttributes(shape);
    }),

    delete: Effect.fn(function* ({ output }: { readonly output: Attrs }) {
      yield* def.delete(output.catalogId);
    }),

    list: () =>
      collectAll(
        def.list.pipe(Stream.filter((shape) => isGeneratedName(shape.name))),
        def.toAttributes,
      ),
  };
};
