import * as boat from "@distilled.cloud/boat-dev/boat";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ApiKeyAction } from "./ApiKey.ts";
import { bindBoat, bindOwnerLabels } from "./BoatBindings.ts";
import { CreateSandbox, type CreateSandboxOptions, type SandboxesClient } from "./CreateSandbox.ts";
import { BoatUnexpectedResponse } from "./Errors.ts";
import { labelFilter } from "./internal/Ownership.ts";
import { makeSandboxHandle, ttlOf } from "./internal/SandboxHandle.ts";
import type { Snapshot } from "./Snapshot.ts";

/** What a `CreateSandbox` host may do: work in sandboxes, and delete only its own. */
const CREATE_SANDBOX_ACTIONS: ApiKeyAction[] = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.fork",
  "sandbox.delete-own",
  "exec",
  "file.read",
  "file.write",
  "host",
  "snapshot.read",
  "snapshot.write",
];

/**
 * HTTP implementation of {@link CreateSandbox}: Boat's REST API with the
 * host's own key. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const sandboxes = yield* Boat.CreateSandbox();
 *   // ...
 * }).pipe(Effect.provide(Boat.CreateSandboxHttp))
 * ```
 *
 * @layer
 * @product Sandbox
 * @provides Boat.CreateSandbox
 */
export const CreateSandboxHttp = Layer.succeed(
  CreateSandbox,
  Effect.fn("Boat.CreateSandbox")(function* (base?: Snapshot) {
    const auth = yield* bindBoat("BoatSandboxesKey", "BOAT_SANDBOXES_KEY", {
      actions: CREATE_SANDBOX_ACTIONS,
    });
    const owner = yield* bindOwnerLabels;
    const baseName: Effect.Effect<string> | undefined =
      base === undefined
        ? undefined
        : yield* (base.name as Output.Output<string, never>).asEffect();

    const handleOf = (sandbox: boat.Sandbox) => makeSandboxHandle(auth, sandbox, owner);

    const client: SandboxesClient = {
      create: Effect.fn("Boat.CreateSandbox.create")(function* (
        createOptions: CreateSandboxOptions = {},
      ) {
        const { autoStop, ...options } = createOptions;
        const from = options.from ?? (baseName === undefined ? undefined : yield* baseName);
        const created = yield* auth.authorize(
          boat.createSandbox({
            ...options,
            ...(autoStop === undefined ? {} : { ttlSeconds: ttlOf(autoStop) }),
            ...(from === undefined ? {} : { from }),
            labels: { ...options.labels, ...(yield* owner) },
          }),
        );
        return handleOf(created.sandbox);
      }),
      connect: Effect.fn("Boat.CreateSandbox.connect")(function* (sandboxId) {
        const got = yield* auth.authorize(boat.getSandbox({ sandboxId }));
        if (got.sandbox === undefined) {
          return yield* new BoatUnexpectedResponse({
            message: `Boat returned no sandbox for ${sandboxId}`,
          });
        }
        return handleOf(got.sandbox);
      }),
      get: Effect.fn("Boat.CreateSandbox.get")(function* (sandboxId) {
        const got = yield* auth.authorize(boat.getSandbox({ sandboxId }));
        if (got.sandbox === undefined) {
          return yield* new BoatUnexpectedResponse({
            message: `Boat returned no sandbox for ${sandboxId}`,
          });
        }
        return got.sandbox;
      }),
      list: Effect.fn("Boat.CreateSandbox.list")(function* (options) {
        const all = yield* auth.authorize(
          Stream.runCollect(
            boat.listSandboxes.items({
              ...(options?.labels === undefined ? {} : { label: labelFilter(options.labels) }),
              ...(options?.state === undefined ? {} : { state: options.state.join(",") }),
            }),
          ),
        );
        return Array.from(all);
      }),
      delete: (sandboxId) =>
        auth.authorize(boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId })).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
    };
    return client;
  }),
);
