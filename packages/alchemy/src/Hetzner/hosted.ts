import { Services } from "@distilled.cloud/hetzner";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import * as Bundle from "../Bundle/Bundle.ts";
import {
  matchesPackageRoot,
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "../Bundle/InstalledPackages.ts";
import { findCwdForBundle, resolveMainPath } from "../Bundle/TempRoot.ts";
import type { ResourceBinding } from "../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
} from "../Server/Process.ts";
import { hashDirectory } from "../Command/Memo.ts";
import { initialCwd } from "../Util/Node.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import { zipCode, type ZipFile } from "../Util/zip.ts";
import { waitForAction } from "./actions.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import { openSshClient, type SshClient } from "./Ssh.ts";

export type HetznerHostRuntimeContext = HostRuntimeContext;

class VolumeAttachTimeout extends Data.TaggedError(
  "Hetzner.VolumeAttachTimeout",
)<{
  volumeId: number;
  serverId: number;
}> {}

export const createHetznerHostRuntimeContext = createHostRuntimeContext;

export interface HetznerBuildOptions extends Bundle.BundleConfig {
  /**
   * Native or Node-only packages to `bun install` into the unit instead
   * of bundling them. Same shape as Fly/Lambda `build.install`.
   */
  readonly install?: PackageInstall;
}

export interface HostedProgramProps {
  main: string;
  handler?: string;
  port?: number;
  env?: Record<string, any>;
  isExternal?: boolean;
  build?: HetznerBuildOptions;
  /**
   * Extra host directories packed into the unit archive (framework
   * client assets, Next.js `.next`, …). Hashed into `code.hash` so
   * asset changes update the unit. Destination is relative to the
   * unit root.
   */
  extraFiles?: ReadonlyArray<ExtraFile>;
}

export interface ExtraFile {
  readonly source: string;
  readonly destination: string;
}

const matchesConfiguredExternal = (
  external: rolldown.InputOptions["external"],
  moduleId: string,
  parentId: string | undefined,
  isResolved: boolean,
): boolean => {
  if (external === undefined) return false;
  if (typeof external === "function") {
    return external(moduleId, parentId, isResolved) === true;
  }
  const matchers = Array.isArray(external) ? external : [external];
  return matchers.some((matcher) =>
    typeof matcher === "string" ? matcher === moduleId : matcher.test(moduleId),
  );
};

/** Normalize a zip destination so it cannot escape the unit root. */
export const extraFileDestination = (destination: string): string => {
  const parts = destination
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  return parts.length === 0 ? "dist" : parts.join("/");
};

const quoteEnvValue = (value: unknown) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return `'${text.replaceAll(/'/g, `'""'`).replaceAll(/\n/g, "\\n")}'`;
};

export const renderEnvFile = (env: Record<string, unknown>) =>
  Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join("\n");

export const collectBindingState = (
  bindings: ResourceBinding<ServiceBinding>[],
) => {
  const active = bindings.filter(
    (binding: ResourceBinding<ServiceBinding> & { action?: string }) =>
      binding.action !== "delete",
  );
  const env = active
    .map((binding) => binding?.data?.env)
    .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {});
  const volumes: Array<{ volumeId: number; path: string }> = [];
  const seen = new Set<string>();
  for (const binding of active) {
    for (const volume of binding?.data?.volumes ?? []) {
      const key = `${volume.volumeId}:${volume.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      volumes.push(volume);
    }
  }
  return { env, volumes };
};

const skipExtraPath = (relative: string) =>
  relative
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (segment) =>
        segment === "node_modules" ||
        segment === ".git" ||
        segment.startsWith(".alchemy-hetzner"),
    );

const resolveExtraSource = (
  source: string,
  path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly resolve: (...segments: string[]) => string;
  },
) => (path.isAbsolute(source) ? source : path.resolve(initialCwd, source));

const hashExtraFiles = Effect.fn(function* (
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hashes: Record<string, string> = {};
  for (const extra of extraFiles ?? []) {
    const dest = extraFileDestination(extra.destination);
    const source = resolveExtraSource(extra.source, path);
    const exists = yield* fs
      .exists(source)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      hashes[dest] = "";
      continue;
    }
    const stat = yield* fs.stat(source);
    hashes[dest] =
      stat.type === "Directory"
        ? yield* hashDirectory({
            cwd: source,
            memo: { exclude: [], lockfile: false },
          }).pipe(Effect.orElseSucceed(() => ""))
        : yield* sha256(yield* fs.readFile(source));
  }
  return hashes;
});

const collectExtraFiles = Effect.fn(function* (
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
) {
  if (extraFiles === undefined || extraFiles.length === 0) {
    return [] as ZipFile[];
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: ZipFile[] = [];
  for (const extra of extraFiles) {
    const dest = extraFileDestination(extra.destination);
    const source = resolveExtraSource(extra.source, path);
    if (!(yield* fs.exists(source))) continue;
    const rootStat = yield* fs.stat(source);
    if (rootStat.type === "File") {
      files.push({
        path: dest,
        content: yield* fs.readFile(source),
      });
      continue;
    }
    const names = yield* fs.readDirectory(source, { recursive: true });
    for (const name of names) {
      if (skipExtraPath(name)) continue;
      const full = path.join(source, name);
      const stat = yield* fs.stat(full);
      if (stat.type !== "File") continue;
      files.push({
        path: `${dest}/${name.replaceAll("\\", "/")}`.replaceAll(/\/+/g, "/"),
        content: yield* fs.readFile(full),
      });
    }
  }
  return files;
});

/**
 * The generated entry for `Hetzner.Service` units: a shim importing only
 * `alchemy/Runtime/Bootstrap/Hetzner` plus the user's `main` — see that
 * module for why the entry never imports alchemy's own dependencies.
 */
const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "alchemy/Runtime/Bootstrap/Hetzner";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

export const createHetznerHostedSupport = ({
  stackName,
  stage,
  virtualEntryPlugin,
}: {
  stackName: string;
  stage: string;
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin;
}) => {
  const alchemyEnv = {
    ALCHEMY_STACK_NAME: stackName,
    ALCHEMY_STAGE: stage,
    ALCHEMY_PHASE: "runtime",
  };

  const bundleProgram = Effect.fn(function* (
    _id: string,
    props: HostedProgramProps,
  ) {
    const handler = props.handler ?? "default";
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);

    const requested = yield* normalizeInstallTargets(props.build?.install);
    const installRoots = new Set(Object.keys(requested));
    const configuredExternal = props.build?.input?.external;

    const buildBundle = Effect.fn(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...props.build?.input,
          input: entry,
          cwd,
          platform: "node",
          external: (moduleId, parentId, isResolved) => {
            if (moduleId === "bun" || moduleId.startsWith("bun:")) return true;
            for (const root of installRoots) {
              if (matchesPackageRoot(moduleId, root)) return true;
            }
            return matchesConfiguredExternal(
              configuredExternal,
              moduleId,
              parentId,
              isResolved,
            );
          },
          resolve: {
            conditionNames: [...Bundle.BUN_CONDITION_NAMES],
            ...props.build?.input?.resolve,
          },
          plugins: [props.build?.input?.plugins, plugins],
        },
        {
          ...props.build?.output,
          format: "esm",
          sourcemap: props.build?.output?.sourcemap ?? false,
          minify: props.build?.output?.minify ?? false,
          entryFileNames: "index.mjs",
        },
        props.build,
      );
    });

    const bundleOutput = props.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(
          realMain,
          virtualEntryPlugin(makeBunBootstrap(handler)),
        );

    const toBytes = (content: string | Uint8Array<ArrayBufferLike>) =>
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const [entryFile, ...chunkFiles] = bundleOutput.files;
    const extraFiles = yield* collectExtraFiles(props.extraFiles);
    const identity =
      Object.keys(requested).length > 0
        ? yield* resolvePackageInstallIdentity({ cwd, requested })
        : undefined;
    const install =
      identity !== undefined && Object.keys(identity.resolved).length > 0
        ? identity.resolved
        : undefined;
    const packageJson =
      install === undefined
        ? undefined
        : `${JSON.stringify(
            { private: true, type: "module", dependencies: install },
            null,
            2,
          )}\n`;
    const zipExtras = [
      ...chunkFiles.map((file) => ({
        path: file.path,
        content: toBytes(file.content),
      })),
      ...extraFiles,
      ...(packageJson !== undefined
        ? [
            {
              path: "package.json",
              content: new TextEncoder().encode(packageJson),
            },
          ]
        : []),
    ];
    const archive = yield* zipCode(toBytes(entryFile.content), zipExtras);
    // Extra files are not part of the rolldown bundle hash. Mix their
    // content hashes so a client-asset-only change still updates the unit.
    const extraHash = yield* hashExtraFiles(props.extraFiles);
    const hash = yield* sha256Object({
      bundle: bundleOutput.hash,
      extra: extraHash,
      packageJson: packageJson ?? "",
    });
    return { archive, hash };
  });

  const renderUnit = (unitName: string, appDir: string) => `[Unit]
Description=Alchemy Hetzner Service ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
EnvironmentFile=-${appDir}/env
ExecStart=/root/.bun/bin/bun --no-install ${appDir}/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  const waitForSsh = (ssh: SshClient) =>
    ssh.exec("true").pipe(
      Effect.retry({
        while: (e) => e._tag === "Hetzner.SshError",
        times: 10,
        schedule: Schedule.min([
          Schedule.exponential(Duration.millis(500), 1.5),
          Schedule.spaced(Duration.seconds(5)),
        ]),
      }),
    );

  const attachAndMount = Effect.fn(function* (input: {
    ssh: SshClient;
    serverId: number;
    volumes: Array<{ volumeId: number; path: string }>;
  }) {
    for (const { volumeId, path } of input.volumes) {
      let volume = yield* Services.volumes.getVolume({ id: volumeId }).pipe(
        Effect.map(({ volume }) => volume),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (volume === undefined) continue;

      if (volume.server !== input.serverId) {
        if (volume.server !== null) {
          yield* Services.volumeActions.detachVolume({ id: volumeId }).pipe(
            Effect.tap(({ action }) =>
              waitForAction(action).pipe(
                Effect.catchTag("ActionTimeout", () => Effect.void),
              ),
            ),
            Effect.catchTag(
              ["NotFound", "UnprocessableEntity", "Locked", "Conflict"],
              () => Effect.void,
            ),
          );
        }
        yield* Services.volumeActions
          .attachVolume({
            id: volumeId,
            server: input.serverId,
            automount: true,
          })
          .pipe(
            Effect.tap(({ action }) =>
              waitForAction(action).pipe(
                Effect.catchTag("ActionTimeout", () => Effect.void),
              ),
            ),
            Effect.catchTag(
              ["UnprocessableEntity", "Locked", "Conflict"],
              () => Effect.void,
            ),
          );
        volume = yield* Services.volumes.getVolume({ id: volumeId }).pipe(
          Effect.flatMap(({ volume }) =>
            volume.server === input.serverId
              ? Effect.succeed(volume)
              : Effect.fail({ _tag: "AttachPending" as const }),
          ),
          Effect.retry({
            while: (e) =>
              e._tag === "AttachPending" ||
              e._tag === "TooManyRequests" ||
              e._tag === "Locked",
            times: 10,
            schedule: Schedule.min([
              Schedule.exponential(Duration.millis(500), 1.5),
              Schedule.spaced(Duration.seconds(5)),
            ]),
          }),
          Effect.catchIf(
            (e) => e._tag === "AttachPending",
            () =>
              Services.volumes.getVolume({ id: volumeId }).pipe(
                Effect.map(({ volume }) => volume),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              ),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      if (volume === undefined || volume.server !== input.serverId) {
        return yield* new VolumeAttachTimeout({
          volumeId,
          serverId: input.serverId,
        });
      }

      const device = volume.linux_device;
      const fsType = volume.format === "xfs" ? "xfs" : "ext4";
      const pathLit = JSON.stringify(path);
      const deviceLit = JSON.stringify(device);
      const fsLit = JSON.stringify(fsType);
      yield* input.ssh.exec(
        [
          `set -euo pipefail`,
          `mkdir -p ${pathLit}`,
          `if ! findmnt -n ${pathLit} >/dev/null 2>&1; then`,
          `  mount -t ${fsLit} ${deviceLit} ${pathLit} || findmnt -n ${pathLit} >/dev/null`,
          `fi`,
          `if ! grep -qF ${pathLit} /etc/fstab; then`,
          `  echo ${JSON.stringify(`${device} ${path} ${fsType} defaults,nofail 0 2`)} >> /etc/fstab`,
          `fi`,
        ].join("\n"),
      );
    }
  });

  const deployUnit = Effect.fn(function* (input: {
    ssh: SshClient;
    unitName: string;
    archive: Uint8Array<ArrayBufferLike>;
    env: Record<string, unknown>;
  }) {
    const appDir = `/opt/${input.unitName}`;
    yield* waitForSsh(input.ssh);
    yield* input.ssh.exec(
      [
        `set -uo pipefail`,
        `export HOME=/root`,
        `export BUN_INSTALL=/root/.bun`,
        `export PATH="/root/.bun/bin:$PATH"`,
        `mkdir -p ${JSON.stringify(appDir)}`,
        `if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then`,
        `  apt-get update`,
        `  DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip ca-certificates`,
        `fi`,
        `if [ ! -x /root/.bun/bin/bun ]; then`,
        `  for attempt in 1 2 3 4 5; do`,
        `    curl -fsSL https://bun.sh/install | bash && break`,
        `    sleep 5`,
        `  done`,
        `fi`,
        `if [ ! -x /root/.bun/bin/bun ]; then`,
        `  echo "bun install failed" >&2`,
        `  exit 1`,
        `fi`,
      ].join("\n"),
    );
    yield* input.ssh.scp(input.archive, `${appDir}/bundle.zip`);
    yield* input.ssh.scp(
      new TextEncoder().encode(renderEnvFile(input.env)),
      `${appDir}/env`,
    );
    yield* input.ssh.scp(
      new TextEncoder().encode(renderUnit(input.unitName, appDir)),
      `/etc/systemd/system/${input.unitName}.service`,
    );
    yield* input.ssh.exec(
      [
        `set -euo pipefail`,
        `export HOME=/root`,
        `export BUN_INSTALL=/root/.bun`,
        `export PATH="/root/.bun/bin:$PATH"`,
        `if [ ! -x /root/.bun/bin/bun ]; then echo "bun missing at start" >&2; exit 1; fi`,
        `unzip -o ${JSON.stringify(`${appDir}/bundle.zip`)} -d ${JSON.stringify(appDir)}`,
        `if [ -f ${JSON.stringify(`${appDir}/package.json`)} ]; then`,
        `  (cd ${JSON.stringify(appDir)} && /root/.bun/bin/bun install --production)`,
        `fi`,
        `systemctl daemon-reload`,
        `systemctl enable --now ${input.unitName}.service`,
        `systemctl restart ${input.unitName}.service`,
      ].join("\n"),
    );
    const port =
      typeof input.env.PORT === "string" ? input.env.PORT : undefined;
    const health =
      port !== undefined
        ? `curl -sf -o /dev/null http://127.0.0.1:${port}/health`
        : "true";
    yield* input.ssh.exec(
      [
        `set -uo pipefail`,
        `for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do`,
        `  if systemctl is-active --quiet ${input.unitName}.service && ${health}; then`,
        `    exit 0`,
        `  fi`,
        `  sleep 2`,
        `done`,
        `echo "unit ${input.unitName} not ready" >&2`,
        `systemctl status ${input.unitName}.service --no-pager || true`,
        `journalctl -u ${input.unitName}.service -n 80 --no-pager || true`,
        `ls -la ${JSON.stringify(appDir)} >&2 || true`,
        `exit 1`,
      ].join("\n"),
    );
  });

  const removeUnit = Effect.fn(function* (input: {
    ssh: SshClient;
    unitName: string;
  }) {
    const appDir = `/opt/${input.unitName}`;
    yield* input.ssh
      .exec(
        [
          `systemctl disable --now ${input.unitName}.service || true`,
          `rm -f /etc/systemd/system/${input.unitName}.service`,
          `rm -rf ${JSON.stringify(appDir)}`,
          `systemctl daemon-reload || true`,
        ].join("\n"),
      )
      .pipe(Effect.catchTag("Hetzner.SshError", () => Effect.void));
  });

  return {
    alchemyEnv,
    bundleProgram,
    attachAndMount,
    deployUnit,
    removeUnit,
    waitForSsh,
    openSshClient,
  };
};
