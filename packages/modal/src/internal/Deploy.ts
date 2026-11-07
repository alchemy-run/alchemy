import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as app from "@distilled.cloud/modal/app";
import * as mount from "@distilled.cloud/modal/mount";
import * as workspace from "@distilled.cloud/modal/workspace";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { type MountCapability, mountInstallLines } from "alchemy/Mount";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { buildImage, ImageBuildOps, type ImageBuildSpec } from "../ImageBuild.ts";
import { checkCommands, lowerPlan, MODAL_CAPABILITIES } from "../ImagePlan.ts";
import { checkModalMounts } from "../Mounts.ts";
import { ENTRYPOINT_PATH, ENTRYPOINT_SOURCE } from "./Entrypoint.ts";

/*
 * Deploy-time plumbing shared by `Modal.Function` and `Modal.Server`: the
 * Python layer and mounts every Modal Function container needs, and
 * publishing a function into its App.
 */

/** Modal returned a response without a field the deploy needs. */
export class ModalDeployUnexpectedResponse extends Data.TaggedError(
  "Modal.DeployUnexpectedResponse",
)<{
  readonly message: string;
}> {}

/**
 * The Modal Python client whose container entrypoint runs the function.
 * Modal publishes it as the global mount `modal-client-mount-<version>`.
 */
export const MODAL_CLIENT_VERSION = "1.6.3";

/** Standalone Python builds Modal publishes as global mounts, by image builder version. */
const PYTHON_STANDALONE: Record<
  "2026.10" | "2025.06",
  Record<string, readonly [string, string]>
> = {
  "2026.10": {
    "3.11": ["20261021", "3.11.17"],
    "3.12": ["20261021", "3.12.15"],
    "3.13": ["20261021", "3.13.17"],
    "3.14": ["20261021", "3.14.9"],
  },
  "2025.06": {
    "3.11": ["20230826", "3.11.5"],
    "3.12": ["20240107", "3.12.1"],
    "3.13": ["20241008", "3.13.0"],
    "3.14": ["20251205", "3.14.2"],
  },
};

/** The Python version added to a base image without one. */
export const DEFAULT_PYTHON = "3.12";

/** Port the program listens on when the resource doesn't set one. */
export const DEFAULT_PORT = 8000;

const lookupMount = (deploymentName: string) =>
  Effect.gen(function* () {
    const { mountId } = yield* mount.mountGetOrCreate({
      deploymentName,
      namespace: "DEPLOYMENT_NAMESPACE_GLOBAL",
      objectCreationType: "OBJECT_CREATION_TYPE_UNSPECIFIED",
    });
    if (!mountId) {
      return yield* new ModalDeployUnexpectedResponse({
        message: `Modal returned no id for mount ${deploymentName}`,
      });
    }
    return mountId;
  });

/** The mount holding Modal's Python client, which runs the container entrypoint. */
export const clientMount = /*@__PURE__*/ lookupMount(`modal-client-mount-${MODAL_CLIENT_VERSION}`);

/**
 * The image builder version builds use: the resource's pin, else the
 * workspace's setting.
 */
const builderVersionOf = Effect.fn(function* (pinned: string | undefined) {
  if (pinned !== undefined) return pinned;
  const settings = yield* workspace.workspaceSettings({});
  return settings.imageBuilderVersion ?? "2025.06";
});

/**
 * Upload {@link ENTRYPOINT_SOURCE} as a mount owned by the app. Modal stores
 * files by content hash, so redeploys reuse it.
 */
export const entrypointMount = Effect.fn(function* (appId: string) {
  const bytes = new TextEncoder().encode(ENTRYPOINT_SOURCE);
  const hash = yield* sha256(bytes);
  const data = yield* Effect.sync(() => Buffer.from(bytes).toString("base64"));
  for (let attempt = 0; attempt < 10; attempt++) {
    const { exists } = yield* mount.mountPutFile({ sha256Hex: hash, data });
    if (exists) break;
  }
  const { mountId } = yield* mount.mountGetOrCreate({
    objectCreationType: "OBJECT_CREATION_TYPE_ANONYMOUS_OWNED_BY_APP",
    appId,
    files: [
      { filename: ENTRYPOINT_PATH, sha256Hex: hash, size: String(bytes.length), mode: 0o100644 },
    ],
  });
  if (!mountId) {
    return yield* new ModalDeployUnexpectedResponse({
      message: "Modal returned no id for the entrypoint mount",
    });
  }
  return mountId;
});

/** What a runtime's image is built from. */
export interface RuntimeImageInput {
  readonly main: string;
  readonly image?: string;
  readonly commands?: ReadonlyArray<string>;
  readonly handler?: string;
  readonly build?: Bundle.BundleConfig;
  readonly isExternal?: boolean;
  readonly python?: string | false;
  readonly builderVersion?: string;
  readonly gpu?: string;
}

/**
 * Plan a runtime's image with the shared BuildPlan: the bundled program on
 * its base image, without the image's `ENTRYPOINT`/`CMD` (Modal starts the
 * container with its own Python entrypoint, which then runs the program).
 */
export const planRuntimeImage = Effect.fn(function* (
  target: string,
  input: RuntimeImageInput,
  port: number,
  bootstrap: ((importPath: string) => string) | undefined,
  capabilities: ReadonlyArray<MountCapability> = [],
) {
  yield* checkModalMounts(target, capabilities);
  const plan = yield* BuildPlan.plan(
    { main: input.main, image: input.image, handler: input.handler, build: input.build },
    {
      capabilities: { ...MODAL_CAPABILITIES, target },
      port,
      bootstrap,
      install: mountInstallLines(capabilities),
    },
  );
  const extra = yield* checkCommands(input.commands ?? []);
  const lowered = yield* lowerPlan(plan, extra);
  const command = [...(BuildPlan.startCommand(plan) ?? [])];
  // Lines after `FROM`, minus the start instruction, run on top of the Python layer.
  const commands = lowered.commands
    .slice(1)
    .filter((line) => !/^\s*(ENTRYPOINT|CMD)\b/i.test(line));
  const python = input.python === undefined ? DEFAULT_PYTHON : input.python;
  const hash = yield* sha256Object({
    plan: plan.hash,
    extra,
    python,
    builder: input.builderVersion,
    gpu: input.gpu,
  });
  return {
    plan,
    command,
    hash,
    warnings: plan.warnings,
    spec: { ...lowered, commands: [...commands, "ENTRYPOINT []"] } satisfies ImageBuildSpec,
    python,
  };
});

/**
 * Build a runtime's image: the base, a layer adding standalone Python
 * (unless `python: false`), then the program.
 */
export const buildRuntimeImage = Effect.fn(function* (
  appId: string,
  planned: {
    readonly plan: BuildPlan.BuildPlan;
    readonly spec: ImageBuildSpec;
    readonly python: string | false;
  },
  options: {
    readonly builderVersion?: string;
    readonly gpu?: string;
    readonly note?: (message: string) => Effect.Effect<void>;
  },
) {
  const builderVersion = yield* builderVersionOf(options.builderVersion);
  const buildOps = yield* ImageBuildOps;
  let baseImageId: string | undefined;
  if (planned.python !== false) {
    const table =
      builderVersion >= "2026.10" || builderVersion === "PREVIEW"
        ? PYTHON_STANDALONE["2026.10"]
        : PYTHON_STANDALONE["2025.06"];
    const release = table[planned.python];
    if (release === undefined) {
      return yield* new ModalDeployUnexpectedResponse({
        message: `Python ${planned.python} isn't available for image builder ${builderVersion}; use one of ${Object.keys(table).join(", ")}`,
      });
    }
    const contextMountId = yield* lookupMount(
      `python-build-standalone.${release[0]}.${release[1]}-gnu`,
    );
    baseImageId = yield* buildImage(
      buildOps,
      appId,
      {
        dockerTag: planned.plan.base,
        commands: [
          "COPY /python/. /usr/local",
          "ENV TERMINFO_DIRS=/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo",
        ],
        contextMountId,
        registry: undefined,
        builderVersion,
      },
      { note: options.note },
    );
  }
  return yield* buildImage(
    buildOps,
    appId,
    {
      ...planned.spec,
      ...(baseImageId !== undefined ? { baseImageId } : { dockerTag: planned.plan.base }),
      gpu: options.gpu,
      builderVersion,
    },
    { note: options.note },
  );
});

/** Serializes publishes per App: each publish replaces the App's whole function map. */
const appLocks = /*@__PURE__*/ new Map<string, Semaphore.Semaphore>();
const lockFor = (appId: string) => {
  let lock = appLocks.get(appId);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    appLocks.set(appId, lock);
  }
  return lock;
};

/**
 * Publish the App with `tag` pointing at `created` (or removed, when
 * `created` is `undefined`), keeping every other function and class the
 * App serves. Modal deploys an App as a whole, so a publish carries the full
 * map read back from the App's current layout.
 *
 * A class function (one with a `classId`) is published as Modal's clients
 * publish `@app.cls`: its service function under `<tag>.*` and its class
 * under `<tag>`, where its containers look the class up.
 */
/** The service function name of the class `tag`, as Modal's clients name it. */
export const classTag = (tag: string) => `${tag}.*`;

export const publishFunction = (
  target: { readonly appId: string; readonly appName: string | undefined },
  tag: string,
  created:
    | {
        readonly functionId: string;
        readonly definitionId: string | undefined;
        readonly classId?: string | undefined;
      }
    | undefined,
) =>
  Semaphore.withPermits(
    lockFor(target.appId),
    1,
  )(
    Effect.gen(function* () {
      const { appLayout } = yield* app.appGetLayout({ appId: target.appId });
      const functionIds: Record<string, string> = {};
      for (const [key, value] of Object.entries(appLayout?.functionIds ?? {})) {
        if (value !== undefined && key !== tag && key !== classTag(tag)) functionIds[key] = value;
      }
      if (created !== undefined) {
        functionIds[created.classId ? classTag(tag) : tag] = created.functionId;
      }
      const classIds: Record<string, string> = {};
      for (const [key, value] of Object.entries(appLayout?.classIds ?? {})) {
        if (value !== undefined && key !== tag) classIds[key] = value;
      }
      if (created?.classId) classIds[tag] = created.classId;
      const published = new Set(Object.values(functionIds));
      const definitionIds: Record<string, string> = {};
      for (const object of appLayout?.objects ?? []) {
        const definitionId = object.functionHandleMetadata?.definitionId;
        if (object.objectId && definitionId && published.has(object.objectId)) {
          definitionIds[object.objectId] = definitionId;
        }
      }
      if (created?.definitionId) definitionIds[created.functionId] = created.definitionId;
      return yield* app.publishApp({
        appId: target.appId,
        name: target.appName,
        appState: "APP_STATE_DEPLOYED",
        functionIds,
        classIds,
        definitionIds,
      });
    }),
  );
