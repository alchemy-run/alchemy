import * as app from "@distilled.cloud/modal/app";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  type EnvironmentInput,
  envNameOf,
  environmentNames,
  environmentOf,
  objectName,
  stringMap,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import { createModalInternalTags, hasModalAlchemyTags, isAlchemyTagged } from "./internal/Tags.ts";
import type { Providers } from "./Providers.ts";

export class AppUnexpectedResponse extends Data.TaggedError("Modal.AppUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface AppProps {
  /**
   * App name, unique per environment. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the app.
   */
  name?: string;
  /**
   * Environment the app lives in. Changing it replaces the app.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
  /**
   * Key-value metadata on the app, shown in the Modal dashboard and usable
   * for filtering. Alchemy adds its own `alchemy.*` ownership tags. Keys and values may
   * contain only letters, digits, `.`, `_` and `-`, up to 63 characters.
   */
  tags?: Record<string, string>;
}

export interface AppAttributes {
  /** App ID (`ap-…`). */
  appId: string;
  /** App name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
  /** Tags on the app, including Alchemy's ownership tags. */
  tags: Record<string, string>;
}

/**
 * A Modal App: the named, persistent namespace that Functions, Servers,
 * Sandboxes and Images run under. Each `Modal.Function` and `Modal.Server`
 * of the Stack is published into its App, and stopping the App (destroying
 * this resource) stops them and terminates its Sandboxes.
 *
 * An App deployed with Modal's Python client (`modal deploy`) can also be
 * referenced by name from {@link InvokeFunction} and
 * {@link FunctionAutoscaler}.
 *
 * ### Creating an App
 * **Example:** An app for sandboxes
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Coder = Modal.App("Coder", {});
 * ```
 *
 * **Example:** A named, tagged app in an environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
import * as Schedule from "effect/Schedule";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Coder = Modal.App("Coder", {
 *   name: "coder",
 *   environment: Agents,
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Running sandboxes in it
 * **Example:** Create sandboxes from a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Coder } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sandbox = yield* sandboxes.create({ image: "node:22-slim" });
 *         const result = yield* sandbox.exec(["node", "--version"]);
 *         yield* sandbox.terminate();
 *         return HttpServerResponse.text(result.stdout);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * ### Looking up an existing App
 * `App.lookup` references a App Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing App
 * ```typescript
 * const app = Modal.App.lookup({ name: "inference" });
 * ```
 *
 * @resource
 * @product App
 */
export const App = declarable<App>()(Resource<App>("Modal.App"));

export type App = Resource<"Modal.App", AppProps, AppAttributes, never, Providers, AppLookup>;

/**
 * Props for {@link App.lookup}: find a App this stack
 * doesn't manage by its name.
 */
export interface AppLookup {
  /** App name. */
  name: string;
  /**
   * Modal environment the object lives in.
   * @default the workspace's default environment
   */
  environment?: string;
}

const isStopped = (state: string | undefined) =>
  state === "APP_STATE_STOPPED" || state === "APP_STATE_STOPPING";

export const AppProvider = () =>
  Provider.effect(
    App,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (name: string, env: string | undefined) {
        // Without a creation type, get-or-create only looks the app up
        // (Modal no longer serves `AppLookup`).
        const found = yield* app
          .appGetOrCreate({ appName: name, environmentName: environmentOf(env) })
          .pipe(Effect.catchTag("AppNotFound", () => Effect.undefined));
        if (!found?.appId) return undefined;
        const { tags } = yield* app
          .appGetTags({ appId: found.appId })
          .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed({ tags: undefined })));
        return {
          appId: found.appId,
          name,
          environment: env,
          tags: stringMap(tags),
        } satisfies AppAttributes;
      });

      return {
        stables: ["appId", "name", "environment"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name, environment }) {
          return yield* observe(name, environment);
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const observed = yield* observe(
            name,
            output?.environment ?? envNameOf(olds?.environment),
          );
          if (!observed) return undefined;
          const ours = yield* hasModalAlchemyTags(id, observed.tags);
          return ours ? observed : Unowned(observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          // Observe + ensure: get-or-create is idempotent under races.
          let current = yield* observe(name, envNameOf(news.environment));
          if (!current) {
            yield* session.note(`Creating app ${name}...`);
            // Modal rate-limits App creation per workspace; wait it out.
            const created = yield* app
              .appGetOrCreate({
                appName: name,
                environmentName: environmentOf(envNameOf(news.environment)),
                objectCreationType: "OBJECT_CREATION_TYPE_CREATE_IF_MISSING",
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "TooManyRequests",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 12,
                }),
              );
            if (!created.appId) {
              return yield* new AppUnexpectedResponse({
                message: `Modal returned no id for app ${name}`,
              });
            }
            current = {
              appId: created.appId,
              name,
              environment: envNameOf(news.environment),
              tags: {},
            };
          }
          // Sync tags against the observed tags. Modal stores the map it is
          // given; it has no per-key delete.
          const desired = { ...news.tags, ...(yield* createModalInternalTags(id)) };
          if (!deepEqual(current.tags, desired)) {
            yield* app.appSetTags({ appId: current.appId, tags: desired });
            current = { ...current, tags: desired };
          }
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* app
            .stopApp({ appId: output.appId, source: "APP_STOP_SOURCE_CLI" })
            .pipe(Effect.catchTag("AppNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: AppAttributes[] = [];
          for (const env of envs) {
            const { apps } = yield* app.listApp({ environmentName: env });
            for (const item of apps ?? []) {
              if (!item.appId || isStopped(item.state)) continue;
              const { tags } = yield* app
                .appGetTags({ appId: item.appId })
                .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed({ tags: undefined })));
              if (!isAlchemyTagged(tags)) continue;
              all.push({
                appId: item.appId,
                name: item.name ?? item.description ?? "",
                environment: env,
                tags: stringMap(tags),
              });
            }
          }
          return all;
        }),
      };
    }),
  );
