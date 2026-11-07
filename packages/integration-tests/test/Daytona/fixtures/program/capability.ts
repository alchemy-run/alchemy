import * as Binding from "alchemy/Binding";
import type { MountCapability } from "alchemy/Mount";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A stand-in for a mount binding (an `alchemy/Mount` capability, as
 * `Archil.MountDisk` binds one): it asks its host's image for a client.
 */
export interface InstallClient extends Binding.Service<
  InstallClient,
  "Test.InstallClient",
  (capability: MountCapability) => Effect.Effect<void>
> {}

export const InstallClient = Binding.Service<InstallClient>("Test.InstallClient");

export const InstallClientLive = Layer.effect(
  InstallClient,
  Effect.succeed(
    Effect.fn(function* (capability: MountCapability) {
      if (globalThis.__ALCHEMY_RUNTIME__) return;
      const host = yield* Binding.Host;
      if (!host) return;
      yield* (
        host as unknown as {
          bind: (sid: string, data: { mounts: MountCapability[] }) => Effect.Effect<void>;
        }
      ).bind(`Test.InstallClient(${capability.id})`, { mounts: [capability] });
    }),
  ),
);

export const jq: MountCapability = {
  id: "jq",
  install: [
    "RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*",
  ],
  requires: { fuse: true },
};

export const nfs: MountCapability = {
  id: "nfs-client",
  install: ["RUN apt-get update && apt-get install -y nfs-common"],
  requires: { nfs: true },
};
