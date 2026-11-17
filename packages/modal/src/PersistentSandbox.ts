import * as persistent from "@distilled.cloud/modal/persistent";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { envNameOf } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Mount } from "./Mounts.ts";
import type { Providers } from "./Providers.ts";
import {
  createPersistentSandbox,
  persistentSandboxHandle,
  SandboxOps,
  type PersistentSandboxCreateOptions,
} from "./SandboxClient.ts";

export interface PersistentSandboxProps extends Omit<PersistentSandboxCreateOptions, "mounts"> {
  /**
   * Volumes and cloud buckets mounted into every session:
   * `[{ volume: Home, path: "/home/user" }]`. Changing them replaces the box.
   */
  mounts?: Mount[];
  /** The App the box runs in (`Modal.App`). Changing it replaces the box. */
  app: { readonly appId: string; readonly name?: string; readonly environment?: unknown };
}

export interface PersistentSandboxAttributes {
  /** Persistent sandbox ID; pass it (or this resource) to `sandboxes.persistent(...)`. */
  persistentSandboxId: string;
  /** The App the box runs in. */
  appId: string;
  /** Name of that App. */
  appName: string | undefined;
  /** Environment of that App. */
  environment: string | undefined;
}

/**
 * A Modal persistent sandbox: one box whose filesystem outlives its
 * sessions. Each session is a regular sandbox that runs up to an hour and
 * pauses after five idle minutes; the next `session()` resumes it from the
 * last session's filesystem. Use it for a long-lived workspace, such as a
 * shared dev box or an agent's home, that the Stack owns.
 *
 * Modal's persistent sandboxes are experimental: they don't take a name,
 * GPUs, `env`, tags or memory snapshots yet. Changing any prop replaces the
 * box (and its files).
 *
 * ### Creating a box
 * **Example:** A dev box on a warm base image
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 * import { Coder, Warm } from "./Coder.ts";
 *
 * export const DevBox = Modal.PersistentSandbox("DevBox", { app: Coder, image: Warm, workdir: "/work" });
 * ```
 *
 * ### Using it at runtime
 * **Example:** Resume it from a Worker
 * ```typescript
 * // construction phase
 * const sandboxes = yield* Modal.CreateSandbox(Coder);
 * const devBoxId = yield* (yield* DevBox).persistentSandboxId;
 * // in fetch:
 * const session = yield* (yield* sandboxes.persistent(yield* devBoxId)).session();
 * const result = yield* session.exec(["git", "status"]);
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const PersistentSandbox = declarable<PersistentSandbox>()(
  Resource<PersistentSandbox>("Modal.PersistentSandbox"),
);

export type PersistentSandbox = Resource<
  "Modal.PersistentSandbox",
  PersistentSandboxProps,
  PersistentSandboxAttributes,
  never,
  Providers
>;

const appOf = (value: PersistentSandboxProps["app"]) => ({
  appId: value.appId,
  appName: value.name,
  environment: envNameOf(value.environment as never),
});

export const PersistentSandboxProvider = () =>
  Provider.effect(
    PersistentSandbox,
    Effect.gen(function* () {
      return {
        stables: ["persistentSandboxId", "appId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          // Modal can't change a persistent sandbox's definition.
          return deepEqual(news, olds) ? undefined : ({ action: "replace" } as const);
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* persistent
            .getPersistentSandbox({ persistentSandboxId: output.persistentSandboxId })
            .pipe(Effect.catchTag("PersistentSandboxNotFound", () => Effect.undefined));
          return found?.persistentSandboxId ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const app = appOf(news.app);
          // Observe: the box still exists.
          if (output !== undefined) {
            const found = yield* persistent
              .getPersistentSandbox({ persistentSandboxId: output.persistentSandboxId })
              .pipe(Effect.catchTag("PersistentSandboxNotFound", () => Effect.undefined));
            if (found?.persistentSandboxId) return output;
          }
          // Ensure.
          yield* session.note("Creating persistent sandbox...");
          const { app: _app, ...options } = news;
          // Resolved by the engine: every mount's resource is attributes by now.
          const handle = yield* createPersistentSandbox(
            yield* SandboxOps,
            app,
            options as PersistentSandboxCreateOptions,
          );
          return {
            persistentSandboxId: handle.persistentSandboxId,
            appId: app.appId,
            appName: app.appName,
            environment: app.environment,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* persistentSandboxHandle(
            yield* SandboxOps,
            output.persistentSandboxId,
            output,
          ).terminate();
        }),
      };
    }),
  );
