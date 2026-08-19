import { Services } from "@distilled.cloud/hetzner";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import * as Bundle from "../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../Bundle/TempRoot.ts";
import type { ResourceBinding } from "../Resource.ts";
import { Self } from "../Self.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
} from "../Server/Process.ts";
import { zipCode } from "../Util/zip.ts";
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

export interface HostedProgramProps {
  main: string;
  handler?: string;
  port?: number;
  env?: Record<string, any>;
  isExternal?: boolean;
  build?: Bundle.BundleConfig;
}

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

const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

const tag = Context.Service(${JSON.stringify(Self.key)});
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.effect(
  Stack,
  Effect.all([
    Config.string("ALCHEMY_STACK_NAME"),
    Config.string("ALCHEMY_STAGE")
  ]).pipe(
    Effect.map(([name, stage]) => ({
      name,
      stage,
      bindings: {},
      resources: {}
    }))
  )
);

const program = tag.pipe(
  Effect.flatMap((service) => service.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Hetzner service bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Hetzner service bootstrap failed:", err);
  process.exit(1);
});
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
          external: [
            "bun",
            "bun:*",
            ...((props.build?.input?.external as string[] | undefined) ?? []),
          ],
          resolve: {
            conditionNames: ["bun", "import", "module", "default"],
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
    const archive = yield* zipCode(
      toBytes(entryFile.content),
      chunkFiles.map((file) => ({
        path: file.path,
        content: toBytes(file.content),
      })),
    );
    return { archive, hash: bundleOutput.hash };
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
        `set -uo pipefail`,
        `if [ ! -x /root/.bun/bin/bun ]; then echo "bun missing at start" >&2; exit 1; fi`,
        `unzip -o ${JSON.stringify(`${appDir}/bundle.zip`)} -d ${JSON.stringify(appDir)}`,
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
        `for attempt in 1 2 3 4 5 6 7 8 9 10; do`,
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
