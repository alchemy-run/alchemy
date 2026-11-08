import * as dict from "@distilled.cloud/modal/dict";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  type EnvironmentInput,
  envNameOf,
  environmentNames,
  environmentOf,
  isGeneratedName,
  listAll,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import { isRuntimeName } from "./RuntimeOwner.ts";

export class DictUnexpectedResponse extends Data.TaggedError("Modal.DictUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface DictProps {
  /**
   * Dict name, unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces the
   * dict (Modal can't rename dicts).
   */
  name?: string;
  /**
   * Environment the dict lives in. Changing it replaces the dict.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
}

export interface DictAttributes {
  /** Dict ID (`di-…`). */
  dictId: string;
  /** Dict name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
}

/**
 * A Modal Dict: a distributed key-value store shared by every container,
 * Sandbox and client in the workspace. Entries expire 7 days after their
 * last write.
 *
 * Bind it with {@link ReadDict}, {@link WriteDict} or {@link ReadWriteDict}
 * to use it from a Worker, Lambda or any other runtime. Values travel as
 * bytes: the bindings encode them as JSON by default.
 *
 * Modal dicts have no tags. Ownership is inferred from Alchemy state: a
 * dict found under an explicit `name` without prior state is reported as
 * unowned.
 *
 * ### Creating a Dict
 * **Example:** A dict with a generated name
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Results = Modal.Dict("Results", {});
 * ```
 *
 * **Example:** A named dict in an environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Sessions = Modal.Dict("Sessions", { name: "sessions", environment: Agents });
 * ```
 *
 * ### Reading and writing from a Worker
 * **Example:** Bind read and write access
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Results } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const results = yield* Modal.ReadWriteDict(Results);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* results.put("last-run", { ok: true });
 *         const last = yield* results.get("last-run");
 *         return yield* HttpServerResponse.json(last ?? null);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadWriteDictHttp)),
 * ) {}
 * ```
 *
 * ### Looking up an existing dict
 * `Dict.lookup` references a dict Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing dict
 * ```typescript
 * const cache = Modal.Dict.lookup({ name: "cache" });
 * ```
 *
 * @resource
 * @product Dict
 */
export const Dict = declarable<Dict>()(Resource<Dict>("Modal.Dict"));

export type Dict = Resource<"Modal.Dict", DictProps, DictAttributes, never, Providers, DictLookup>;

/**
 * Props for {@link Dict.lookup}: find a dict this stack
 * doesn't manage by its name.
 */
export interface DictLookup {
  /** Dict name. */
  name: string;
  /**
   * Modal environment the object lives in.
   * @default the workspace's default environment
   */
  environment?: string;
}

/** A dict by name, or `undefined` when missing. */
export const lookupDict = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof dict.dictGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const found = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_UNSPECIFIED",
  }).pipe(Effect.catchTag("DictNotFound", () => Effect.undefined));
  if (!found?.dictId) return undefined;
  return { dictId: found.dictId, name, environment: env } satisfies DictAttributes;
});

/**
 * Get a dict by name, creating it when missing: the one implementation behind
 * {@link Dict}'s reconcile and the runtime {@link CreateDict} client.
 */
export const ensureDict = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof dict.dictGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const created = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_CREATE_IF_MISSING",
  });
  if (!created.dictId) {
    return yield* new DictUnexpectedResponse({ message: `Modal returned no id for dict ${name}` });
  }
  return { dictId: created.dictId, name, environment: env } satisfies DictAttributes;
});

export const DictProvider = () =>
  Provider.effect(
    Dict,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        dictId: string | undefined,
        name: string,
        env: string | undefined,
      ) {
        if (dictId !== undefined) {
          const byId = yield* dict
            .dictGetById({ dictId })
            .pipe(Effect.catchTag("DictNotFound", () => Effect.undefined));
          if (byId?.dictId) {
            return {
              dictId: byId.dictId,
              name: byId.metadata?.name ?? name,
              environment: env,
            } satisfies DictAttributes;
          }
        }
        return yield* lookupDict(yield* dict.dictGetOrCreate, name, env);
      });

      return {
        stables: ["dictId", "name", "environment"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name, environment }) {
          return yield* observe(undefined, name, environment);
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const observed = yield* observe(output?.dictId, name, envNameOf(olds?.environment));
          if (!observed) return undefined;
          return output !== undefined || olds?.name === undefined ? observed : Unowned(observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          const current = yield* observe(output?.dictId, name, envNameOf(news.environment));
          if (current) return current;
          yield* session.note(`Creating dict ${name}...`);
          return yield* ensureDict(yield* dict.dictGetOrCreate, name, envNameOf(news.environment));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* dict
            .deleteDict({ dictId: output.dictId })
            .pipe(Effect.catchTag("DictNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: DictAttributes[] = [];
          for (const env of envs) {
            const items = yield* listAll(
              (pagination) =>
                dict
                  .listDict({ environmentName: env, pagination })
                  .pipe(Effect.map((response) => response.dicts ?? [])),
              (item) => item.createdAt,
            );
            for (const item of items) {
              if (!item.dictId || !(isGeneratedName(item.name) || isRuntimeName(item.name)))
                continue;
              all.push({ dictId: item.dictId, name: item.name ?? "", environment: env });
            }
          }
          return all;
        }),
      };
    }),
  );
