import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CreateSandbox, type SandboxBase, type SandboxesClient } from "./CreateSandbox.ts";
import { bindE2B, bindOwnerTags, metadataQuery } from "./E2BBindings.ts";
import { SandboxBaseMissing } from "./Errors.ts";
import { denyUnlisted, makeSandboxHandle } from "./internal/SandboxHandle.ts";
import type { BoundVolumeMount, VolumeMount } from "./MountVolume.ts";
import type { Template } from "./Template.ts";

/**
 * HTTP implementation of {@link CreateSandbox}: E2B's control plane with the
 * team key, and envd inside each sandbox with that sandbox's own token.
 * Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const sandboxes = yield* E2B.CreateSandbox(Agent);
 *   // ...
 * }).pipe(Effect.provide(E2B.CreateSandboxHttp))
 * ```
 *
 * @layer
 * @product Sandbox
 * @provides E2B.CreateSandbox
 */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  Effect.gen(function* () {
    return Effect.fn("E2B.CreateSandbox")(function* (base?: SandboxBase) {
      const auth = yield* bindE2B;
      const owner = yield* bindOwnerTags;
      // Both a Template and a Snapshot expose the template id sandboxes boot from.
      const baseId: Effect.Effect<string> | undefined =
        base === undefined
          ? undefined
          : yield* (base.templateId as Output.Output<string, never>).asEffect();
      // A template program's own mounts (`E2B.MountVolume`) go on every sandbox.
      const baseMounts: Effect.Effect<ReadonlyArray<VolumeMount>> =
        base !== undefined && base.Type === "E2B.Template"
          ? yield* ((base as Template).mounts as Output.Output<VolumeMount[], never>).asEffect()
          : Effect.succeed([]);

      /** The template's mounts and the call's own, by path (the call's win). */
      const mountsOf = Effect.fn(function* (
        mounts: ReadonlyArray<VolumeMount | BoundVolumeMount> | undefined,
      ) {
        const byPath = new Map<string, { name: string; path: string }>();
        for (const mount of yield* baseMounts) {
          byPath.set(mount.path, { name: mount.volume.name, path: mount.path });
        }
        for (const mount of mounts ?? []) {
          const name =
            typeof mount.volume.name === "string" ? mount.volume.name : yield* mount.volume.name;
          byPath.set(mount.path, { name, path: mount.path });
        }
        return [...byPath.values()];
      });

      const withStamp = Effect.fn(function* (
        metadata: Readonly<Record<string, string | undefined>> | undefined,
      ) {
        return { ...metadata, ...(yield* owner) };
      });

      const client: SandboxesClient = {
        create: Effect.fn("E2B.CreateSandbox.create")(function* (createOptions) {
          const templateID =
            createOptions?.templateID ?? (baseId === undefined ? undefined : yield* baseId);
          if (templateID === undefined) {
            return yield* new SandboxBaseMissing({
              message: "E2B.CreateSandbox() has no bound base: pass `templateID` to create()",
            });
          }
          const domain = yield* auth.domain;
          const { mounts, ...request } = createOptions ?? {};
          const volumeMounts = yield* mountsOf(mounts);
          const created = yield* auth.authorize(
            sandboxes.createSandbox({
              ...request,
              ...(volumeMounts.length === 0 ? {} : { volumeMounts }),
              ...(createOptions?.network === undefined
                ? {}
                : { network: denyUnlisted(createOptions.network) }),
              templateID,
              metadata: yield* withStamp(createOptions?.metadata),
            }),
          );
          return makeSandboxHandle(auth, created, domain);
        }),
        connect: Effect.fn("E2B.CreateSandbox.connect")(function* (sandboxId, connectOptions) {
          const domain = yield* auth.domain;
          const connected = yield* auth.authorize(
            sandboxes.connectSandbox({ sandboxID: sandboxId, ...connectOptions }),
          );
          return makeSandboxHandle(auth, connected, domain);
        }),
        get: (sandboxId) => auth.authorize(sandboxes.getSandbox({ sandboxID: sandboxId })),
        list: Effect.fn("E2B.CreateSandbox.list")(function* (listOptions) {
          const template =
            listOptions?.template ?? (baseId === undefined ? undefined : yield* baseId);
          const all = yield* auth.authorize(
            Stream.runCollect(
              sandboxes.listSandboxes.items({
                ...listOptions,
                ...(template === undefined ? {} : { template }),
                metadata:
                  listOptions?.metadata === undefined
                    ? undefined
                    : metadataQuery(listOptions.metadata),
              }),
            ),
          );
          return Array.from(all);
        }),
        kill: (sandboxId) =>
          auth.authorize(sandboxes.deleteSandbox({ sandboxID: sandboxId })).pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
          ),
        metrics: (sandboxIds) =>
          auth.authorize(sandboxes.listSandboxesMetrics({ sandbox_ids: [...sandboxIds] })),
      };
      return client;
    });
  }),
);
