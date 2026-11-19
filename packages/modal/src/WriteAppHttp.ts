import * as app from "@distilled.cloud/modal/app";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { operations } from "./internal.ts";
import { WriteApp, type AppWriter } from "./WriteApp.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const WriteAppOps = operations({
  rollback: app.appRollback,
  rollover: app.appRollover,
  promote: app.promoteApp,
  stop: app.stopApp,
});

export type WriteAppOps = Effect.Success<typeof WriteAppOps>;

/**
 * {@link WriteApp} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the App's environment.
 *
 * @layer
 * @product App
 * @provides Modal.WriteApp
 */
export const WriteAppHttp = Layer.effect(
  WriteApp,
  makeModalBinding({
    tag: "Modal.WriteApp",
    operations: WriteAppOps,
    role: "contributor",
    make: Effect.fn(function* (target: App, ops) {
      const appId = yield* target.appId;
      return {
        rollback: (options = {}) =>
          Effect.flatMap(appId, (id) => ops.rollback({ appId: id, version: options.version })).pipe(
            Effect.asVoid,
          ),
        rollover: () =>
          Effect.flatMap(appId, (id) => ops.rollover({ appId: id })).pipe(Effect.asVoid),
        promote: (version) =>
          Effect.flatMap(appId, (id) => ops.promote({ appId: id, version })).pipe(Effect.asVoid),
        stop: () =>
          Effect.flatMap(appId, (id) =>
            ops.stop({ appId: id, source: "APP_STOP_SOURCE_CLI" }),
          ).pipe(Effect.asVoid),
      } satisfies AppWriter;
    }),
  }),
);
