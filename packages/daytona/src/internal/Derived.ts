import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import * as config from "@distilled.cloud/daytona/config";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import {
  checkMountSupport,
  collectMountCapabilities,
  mountInstallLines,
  type MountCapability,
} from "alchemy/Mount";
import * as Effect from "effect/Effect";
import {
  buildSnapshot,
  capabilities,
  deleteSnapshot,
  getSnapshot,
  waitForSnapshot,
} from "../Snapshot.ts";

/**
 * INTERNAL — the snapshot a sandbox boots from when its bindings bind
 * `alchemy/Mount` capabilities: `FROM` the base snapshot's image plus the
 * capabilities' install lines, built on Daytona. It is named from the
 * sandbox and a hash of its Dockerfile, belongs to the sandbox, and is
 * deleted with it.
 */

/** What Daytona sandboxes provide to mount clients (checked live 2026-11-04). */
export const MOUNT_SUPPORT = {
  // `/dev/fuse` exists and the sandbox has CAP_SYS_ADMIN.
  fuse: true,
  // No NFS client is installed, and `mount -t nfs` was never verified.
  nfs: false,
} as const;

/** A binding entry that is a mount capability (not a volume to mount). */
export const isMountCapability = (entry: unknown): entry is MountCapability =>
  typeof entry === "object" && entry !== null && "install" in entry && "id" in entry;

/** The capabilities bound onto a sandbox, de-duplicated in a stable order. */
export const capabilitiesOf = (
  bindings: ReadonlyArray<{ readonly data?: { readonly mounts?: ReadonlyArray<unknown> } }>,
) =>
  collectMountCapabilities(
    bindings.map((binding) => ({
      data: { mounts: (binding.data?.mounts ?? []).filter(isMountCapability) },
    })),
  );

/** The capabilities' install lines; run as root, as `alchemy/Mount` specifies. */
export const installLinesOf = (caps: ReadonlyArray<MountCapability>) =>
  caps.length === 0 ? [] : ["USER root", ...mountInstallLines(caps)];

/** Fail the plan when a capability needs what a sandbox can't provide. */
export const checkSupport = (caps: ReadonlyArray<MountCapability>) => {
  const unsupported = checkMountSupport("Daytona.Sandbox", caps, MOUNT_SUPPORT);
  return unsupported ? Effect.fail(unsupported) : Effect.void;
};

/** The image a snapshot (or, without one, Daytona's default) was made from. */
const baseImageOf = Effect.fn(function* (snapshot: string | undefined) {
  const name = snapshot ?? (yield* config.getConfigControllerConfig({})).defaultSnapshot;
  return (yield* snapshots.getSnapshot({ id: name })).imageName;
});

/**
 * Build (or reuse) the derived snapshot for a sandbox and return its name.
 */
export const ensureDerivedSnapshot = Effect.fn(function* (input: {
  readonly sandboxName: string;
  readonly snapshot: string | undefined;
  readonly caps: ReadonlyArray<MountCapability>;
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const baseImage = yield* baseImageOf(input.snapshot);
  const plan = yield* BuildPlan.plan(
    { dockerfile: { content: `FROM ${baseImage}\n` } },
    { capabilities, install: installLinesOf(input.caps) },
  );
  const name = `${input.sandboxName.slice(0, 40)}-${plan.hash.slice(0, 12)}`.toLowerCase();
  let existing = yield* getSnapshot(name);
  // A failed build is rebuilt; the name is free once the old one is gone.
  if (existing !== undefined && ["error", "build_failed", "removing"].includes(existing.state)) {
    yield* deleteSnapshot(existing.id);
    existing = undefined;
  }
  if (existing === undefined) {
    yield* buildSnapshot({
      name,
      source: { dockerfile: DockerfileParser.render(plan.dockerfile), run: [] },
      labels: {},
      note: input.note,
    });
  }
  yield* waitForSnapshot(name);
  return name;
});
