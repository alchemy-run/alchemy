import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { OpError } from "./internal.ts";
import type { WriteAppOps } from "./WriteAppHttp.ts";

/** Change an App's deployment. */
export interface AppWriter {
  /** Redeploy an earlier version (the previous one by default). */
  rollback(options?: {
    readonly version?: number;
  }): Effect.Effect<void, OpError<WriteAppOps, "rollback">, RuntimeContext>;
  /** Restart every container on the current version, draining the old ones. */
  rollover(): Effect.Effect<void, OpError<WriteAppOps, "rollover">, RuntimeContext>;
  /** Put a staged version into production. */
  promote(version: number): Effect.Effect<void, OpError<WriteAppOps, "promote">, RuntimeContext>;
  /** Stop the App: its functions stop serving and its sandboxes terminate. */
  stop(): Effect.Effect<void, OpError<WriteAppOps, "stop">, RuntimeContext>;
}

/**
 * Operate a Modal App from any runtime: roll back a bad version, roll the
 * containers over, promote a staged version, or stop it. The next deploy of
 * the Stack publishes its declared version again.
 *
 * ### Roll back
 * **Example:** From an incident webhook
 * ```typescript
 * const backend = yield* Modal.WriteApp(Backend);
 * yield* backend.rollback();
 * ```
 *
 * @binding
 * @product App
 */
export interface WriteApp extends Binding.Service<
  WriteApp,
  "Modal.WriteApp",
  (app: App) => Effect.Effect<AppWriter>
> {}

export const WriteApp = Binding.Service<WriteApp>("Modal.WriteApp");
