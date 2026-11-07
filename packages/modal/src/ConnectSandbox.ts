import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { PersistentSandbox } from "./PersistentSandbox.ts";
import {
  persistentSandboxHandle,
  type PersistentSandboxHandleOf,
  SandboxOps,
} from "./SandboxClient.ts";

/**
 * A declared `Modal.PersistentSandbox`, reached from a runtime: its id, and
 * the box's session API.
 */
export interface ConnectedPersistentSandbox extends Omit<
  PersistentSandboxHandleOf<RuntimeContext>,
  "persistentSandboxId"
> {
  /** The box's id (`ps-…`). */
  readonly persistentSandboxId: Effect.Effect<string>;
}

/**
 * Connect to a declared `Modal.PersistentSandbox` from any runtime. The
 * handle follows Modal's session API: `session()` returns the running
 * session, resuming the box from its last session's filesystem when it's
 * paused, and every session is a full sandbox handle (`exec`, `files`,
 * snapshots).
 *
 * ### Use a persistent box
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { DevBox } from "./DevBox.ts";
 *
 * export default class Shell extends Cloudflare.Worker<Shell>()(
 *   "Shell",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const box = yield* Modal.ConnectSandbox(DevBox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const session = yield* box.session();
 *         const status = yield* session.exec("git status");
 *         return HttpServerResponse.text(status.stdout);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ConnectSandboxHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "Modal.ConnectSandbox",
  (box: PersistentSandbox) => Effect.Effect<ConnectedPersistentSandbox>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("Modal.ConnectSandbox");

/**
 * {@link ConnectSandbox} over Modal's API. Grants the runtime's identity the
 * `contributor` role on the box's environment.
 *
 * @layer
 * @product Sandbox
 * @provides Modal.ConnectSandbox
 */
export const ConnectSandboxHttp = Layer.effect(
  ConnectSandbox,
  makeModalBinding({
    tag: "Modal.ConnectSandbox",
    operations: SandboxOps,
    role: "contributor",
    make: Effect.fn(function* (box: PersistentSandbox, ops) {
      const persistentSandboxId = yield* box.persistentSandboxId;
      const environment = yield* box.environment;
      // The box's identity resolves at runtime, on each call.
      const handle = Effect.map(Effect.all([persistentSandboxId, environment]), ([id, env]) =>
        persistentSandboxHandle(ops, id, { environment: env }),
      );
      return {
        persistentSandboxId,
        session: () => Effect.flatMap(handle, (h) => h.session()),
        terminate: () => Effect.flatMap(handle, (h) => h.terminate()),
      } satisfies ConnectedPersistentSandbox;
    }),
  }),
);

/** {@link ConnectSandboxHttp}: Modal has one transport, so both names provide it. */
export const ConnectSandboxLive = ConnectSandboxHttp;
