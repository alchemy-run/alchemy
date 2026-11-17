import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CreateSandbox, type CreateSandboxClient } from "./CreateSandbox.ts";
import { makeAccess, makeOwnerLabels, withOwnerLabels } from "./DaytonaBindings.ts";
import { definedLabels } from "./internal/Labels.ts";
import { waitForState } from "./internal/Wait.ts";
import { volumeIdOf } from "./MountVolume.ts";
import { makeSandboxClient } from "./SandboxClient.ts";
import type { Snapshot } from "./Snapshot.ts";

/** {@link CreateSandbox} over Daytona's HTTP API; works on any host. */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* (base?: Snapshot) {
      const purpose = `${base?.LogicalId ?? ""}Sandboxes`;
      const { authorize, organizationId } = yield* access(purpose, [
        "write:sandboxes",
        "delete:sandboxes",
      ]);
      const ownerLabels = yield* makeOwnerLabels;
      const baseName = base ? yield* base.name : undefined;

      const handle = (s: sandboxes.Sandbox2) =>
        Effect.succeed(makeSandboxClient(s, organizationId, authorize));

      const client: CreateSandboxClient = {
        create: (input) =>
          authorize(
            Effect.gen(function* () {
              const labels = withOwnerLabels(
                input?.labels ? definedLabels(input.labels) : undefined,
                yield* ownerLabels,
              );
              const snapshot = input?.snapshot ?? (baseName ? yield* baseName : undefined);
              const { mounts, ...request } = input ?? {};
              const volumes = mounts
                ? yield* Effect.forEach(mounts, (m) =>
                    Effect.map(volumeIdOf(m.volume), (volumeId) => ({
                      volumeId,
                      mountPath: m.path,
                      subpath: m.subpath,
                    })),
                  )
                : undefined;
              const created = yield* sandboxes.createSandbox({
                ...request,
                snapshot,
                labels,
                volumes,
              });
              return yield* waitForState({
                kind: "sandbox",
                id: created.id,
                observe: sandboxes.getSandbox({ sandboxIdOrName: created.id }),
                want: ["started"],
                fail: ["error", "build_failed", "destroyed"],
                reason: (s) => s.errorReason,
                budget: "5 minutes",
              });
            }),
          ).pipe(Effect.flatMap(handle)),
        get: (idOrName) =>
          authorize(
            sandboxes.getSandbox({ sandboxIdOrName: idOrName }).pipe(
              Effect.map((s) =>
                s.state === "destroyed" || s.state === "destroying" ? undefined : s,
              ),
              Effect.catchTag("SandboxNotFound", () => Effect.undefined),
            ),
          ).pipe(Effect.flatMap((s) => (s ? handle(s) : Effect.undefined))),
        list: (input) =>
          authorize(
            Effect.gen(function* () {
              const snapshots = input?.snapshots ?? (baseName ? [yield* baseName] : undefined);
              const page = yield* sandboxes.listSandboxes({
                ...input,
                snapshots,
                labels: input?.labels ? JSON.stringify(input.labels) : undefined,
              });
              return page.items;
            }),
          ),
        delete: (idOrName) =>
          authorize(
            sandboxes.deleteSandbox({ sandboxIdOrName: idOrName }).pipe(
              Effect.asVoid,
              Effect.catchTag("SandboxNotFound", () => Effect.void),
            ),
          ),
      };
      return client;
    });
  }),
);
