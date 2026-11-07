import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import type { DockerfileBuild } from "@alchemy.run/docker/ImageSource";
import * as templates from "@distilled.cloud/e2b/templates";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved } from "alchemy/Diff";
import {
  checkMountSupport,
  collectMountCapabilities,
  type MountCapability,
  mountEnv,
  mountInstallLines,
} from "alchemy/Mount";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import { DEFAULT_PORT, makeBootstrap, programEnv, programReadyCmd } from "./internal/Program.ts";
import {
  planTemplateBuild,
  runTemplateBuild,
  type LoweredSource,
  type TemplateBuildSpec,
  type TemplateSteps,
} from "./internal/TemplateBuild.ts";
import { planSource } from "./internal/TemplatePlan.ts";
import type { VolumeMount } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";

export type { TemplateFile, TemplateRegistry, TemplateSteps } from "./internal/TemplateBuild.ts";

export interface TemplateProps extends Omit<TemplateSteps, "env">, PlatformProps {
  /**
   * A Dockerfile: a path (relative to the working directory) or inline
   * content (`Dockerfile.inline` from `@alchemy.run/docker`). Lowered to
   * E2B build steps; see the resource docs for what E2B supports.
   * Exclusive with `image` and `fromTemplate` unless `main` is set, where
   * it is the program's environment.
   */
  dockerfile?: string | InlineDockerfile;
  /**
   * The directory `COPY` / `ADD` sources are relative to, for a Dockerfile
   * path. An inline Dockerfile has no build context.
   * @default the working directory
   */
  context?: string;
  /**
   * A program to run in every sandbox: a module entrypoint, typically
   * `import.meta.url` in the class form. Alchemy bundles it, copies it into
   * the template under `/app`, and starts it with Bun as the template's start
   * command, so every sandbox boots with it already serving on {@link port}.
   * `image` / `dockerfile` are then the program's environment, which must
   * have Bun; the default is `oven/bun:1`.
   * @default no program
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Port the program serves HTTP on, as `PORT`. A sandbox serves it at
   * `(yield* sandbox.getTcpPort(port)).url`.
   * @default 3000
   */
  port?: number;
  /**
   * Bundler configuration for `main`, and `args` for the Dockerfile's
   * `ARG`s (like `docker build --build-arg`).
   */
  build?: Bundle.BundleConfig & Pick<DockerfileBuild, "args">;
  /**
   * Environment variables for the template. With a program, also the
   * program's environment, after the values its bindings set.
   *
   * Values are written into the template, so every sandbox created from it
   * can read them. A `Redacted` value is not exposed in Alchemy's state or
   * logs, but code inside the sandbox can read it.
   */
  env?: Record<string, any>;
  /**
   * Template name, used to create sandboxes from it. Lowercase letters,
   * digits, `-` and `_`. If omitted, a unique name is generated from the
   * stack, stage and logical ID. Changing it replaces the template.
   */
  name?: string;
  /** Tags assigned to each build, e.g. `["v1"]`. */
  tags?: string[];
  /**
   * vCPUs of every sandbox created from the template.
   * @default 2
   */
  cpuCount?: number;
  /**
   * Memory of every sandbox created from the template, in MiB.
   * @default 512
   */
  memoryMB?: number;
  /** Free disk space every sandbox starts with, in MiB. */
  minFreeDiskMb?: number;
  /**
   * Whether other E2B teams can create sandboxes from the template.
   * @default false
   */
  public?: boolean;
  /** Rebuild every layer on the next deploy, ignoring E2B's cache. */
  force?: boolean;
}

export interface TemplateAttributes {
  /** E2B's template id. Sandboxes are created from it. */
  templateId: string;
  /** The template's name (alias). */
  name: string;
  /** The current build. */
  buildId: string;
  /** Content hash of the build inputs. A deploy rebuilds only when it changes. */
  buildHash: string;
  /** Content hash of the build inputs other than bindings' env, compared at plan time. */
  sourceHash: string;
  /** Fully qualified names, e.g. `my-team/my-template:default`. */
  names: string[];
  public: boolean;
  cpuCount: number | undefined;
  memoryMB: number | undefined;
  /**
   * Volumes the template's program mounts (`E2B.MountVolume`). E2B attaches
   * volumes when a sandbox is created, so `CreateSandbox(template)` and
   * `E2B.Sandbox({ template })` mount them on every sandbox.
   */
  mounts: VolumeMount[];
}

/** What bindings attach to a template program. */
export interface TemplateBinding {
  /** The program's environment. */
  env?: Record<string, any>;
  /**
   * Mount clients (`alchemy/Mount`) the program needs, installed into the
   * template. E2B sandboxes have FUSE and NFS.
   */
  mounts?: ReadonlyArray<MountCapability>;
  /** E2B volumes every sandbox from the template mounts (`E2B.MountVolume`). */
  volumes?: VolumeMount[];
}

export interface Template extends Resource<
  "E2B.Template",
  TemplateProps,
  TemplateAttributes,
  TemplateBinding,
  Providers,
  { name: string }
> {}

/**
 * An E2B template: the image every sandbox boots from, built by E2B into a
 * Firecracker snapshot.
 *
 * Build from a registry `image`, a `dockerfile` (a path or inline content),
 * or another template (`fromTemplate`). E2B builds remotely, so a deploy
 * needs no Docker daemon: Alchemy plans the Dockerfile with
 * `@alchemy.run/docker`'s build plan, lowers it to E2B's build steps, and
 * uploads only the `COPY` sources E2B has not seen, by content hash. A
 * deploy starts a new build only when the inputs change.
 *
 * E2B's builder runs one stage for `linux/amd64`. A Dockerfile with several
 * `FROM`s, `COPY --from`, `ADD <url>`, heredocs, `RUN --mount` or `SHELL`
 * fails at plan time with `UnsupportedDockerfile`, listing the lines.
 * `EXPOSE`, `LABEL`, `VOLUME`, `HEALTHCHECK` and `STOPSIGNAL` are ignored,
 * as E2B ignores them. An `ARG` becomes an environment variable. `CMD` / `ENTRYPOINT`
 * become the template's start command: it is captured running in the
 * snapshot, so every sandbox starts with it already up.
 *
 * E2B templates carry no labels, so Alchemy recognises its templates by
 * their generated name.
 *
 * ### Building a Template
 * **Example:** From a registry image
 * ```typescript
 * export const Python = E2B.Template("Python", { image: "python:3.12-slim" });
 * ```
 *
 * **Example:** From an inline Dockerfile
 * ```typescript
 * import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
 *
 * export const Agent = E2B.Template("Agent", {
 *   dockerfile: Dockerfile.inline`
 *     FROM node:22-bookworm
 *     RUN apt-get update && apt-get install -y git ripgrep
 *     WORKDIR /work
 *   `,
 *   cpuCount: 2,
 *   memoryMB: 4096,
 * });
 * ```
 *
 * **Example:** From a Dockerfile and its build context
 * ```typescript
 * export const Repo = E2B.Template("Repo", {
 *   context: "./sandbox",
 *   dockerfile: "./sandbox/Dockerfile",
 *   build: { args: { NODE_VERSION: "22" } },
 * });
 * ```
 *
 * ### Starting a process in every sandbox
 * **Example:** A dev server that is already running when a sandbox starts
 * ```typescript
 * export const Preview = E2B.Template("Preview", {
 *   image: "node:22-bookworm",
 *   run: ["npm create vite@latest app -- --template react", "cd app && npm install"],
 *   startCmd: "cd /home/user/app && npm run dev -- --host 0.0.0.0 --port 3000",
 *   readyCmd: "curl -sf http://localhost:3000",
 * });
 * ```
 *
 * ### Private base images
 * **Example:** A base image in GHCR
 * ```typescript
 * export const Private = E2B.Template("Private", {
 *   image: "ghcr.io/my-org/base:1",
 *   registry: { username: "my-org", password: Config.Redacted("GHCR_TOKEN") },
 * });
 * ```
 *
 * ### Effect program
 * Give the template a `main` and an Effect, and every sandbox from it boots
 * with the program already serving HTTP on `port`. Alchemy bundles `main`,
 * copies it into the template, and E2B snapshots the template once the
 * program answers. The program runs with Bun; the image defaults to
 * `oven/bun:1`.
 *
 * **Example:** A program in every sandbox
 * ```typescript
 * export default class Program extends E2B.Template<Program>()(
 *   "Program",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from a sandbox")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Call the program in a sandbox
 * ```typescript
 * const sandboxes = yield* E2B.CreateSandbox(Program);
 * const sandbox = yield* sandboxes.create({ timeout: 300 });
 * const port = yield* sandbox.getTcpPort(3000);
 * const res = yield* port.fetch(HttpClientRequest.get("/"));
 * ```
 *
 * ### Async program
 * A `main` without an Effect is bundled and run with Bun as-is. It must
 * listen on `PORT`. `E2B.InferEnv` types its `env`.
 *
 * **Example:** A plain server
 * ```typescript
 * export const Server = E2B.Template("Server", {
 *   main: "./src/server.mjs",
 *   env: { GREETING: "hi" },
 * });
 * export type ServerEnv = E2B.InferEnv<typeof Server>;
 * ```
 *
 * ### Bindings in the sandbox
 * Bindings work inside a template program like in any other host.
 *
 * :::caution[Values are part of the template]
 * Config and binding values are written into the template, so code in a
 * sandbox can read them, `Redacted` ones included. Use egress secrets for
 * credentials untrusted code must not see.
 * :::
 *
 * **Example:** Read a volume from the program
 * ```typescript
 * export default class Program extends E2B.Template<Program>()(
 *   "Program",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const reports = yield* E2B.ReadVolume(Reports);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return HttpServerResponse.text(yield* reports.readText("/latest.json"));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(E2B.ReadVolumeHttp)),
 * ) {}
 * ```
 *
 * ### Configuration
 * **Example:** Size, image and port
 * ```typescript
 * export default class Program extends E2B.Template<Program>()(
 *   "Program",
 *   { main: import.meta.url, image: "oven/bun:1-debian", cpuCount: 4, memoryMB: 8192, port: 8080 },
 *   Effect.gen(function* () {
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Sandboxes from the template, in a Worker
 * ```typescript
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * const sandbox = yield* sandboxes.create({ timeout: 600 });
 * ```
 *
 * ### Referencing a template the stack doesn't manage
 * `E2B.Template.lookup` finds an existing template by name. Nothing is created,
 * adopted or deleted.
 *
 * **Example:** Look one up by name
 * ```typescript
 * const base = E2B.Template.lookup({ name: "my-team/base-image" });
 * const sandboxes = yield* E2B.CreateSandbox(base);
 * ```
 *
 * @resource
 * @product Template
 */
export const Template: Platform<Template, ServerHost, Main<ServerHost>, HostRuntimeContext> & {
  /**
   * Reference a template this stack doesn't manage (E2B's `base`, or one
   * another stack builds) by name, without managing it.
   */
  lookup(props: { name: string }): Template;
} = Platform("E2B.Template", {
  createRuntimeContext: createContainerRuntimeContext("E2B.Template"),
});

/** A template by id, or by name (alias). */
export const observeTemplate = (templateId: string | undefined, name: string) =>
  (templateId !== undefined
    ? templates.getTemplate({ templateID: templateId })
    : templates
        .getTemplateByAlias({ alias: name })
        .pipe(Effect.flatMap((alias) => templates.getTemplate({ templateID: alias.templateID })))
  ).pipe(
    Effect.map((template): templates.GetTemplateResponse | undefined => template),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The mounts the template's bindings attach, by path (a later binding wins). */
const boundMounts = (
  bindings: ReadonlyArray<ResourceBinding<TemplateBinding>> | undefined,
): VolumeMount[] => [
  ...new Map(
    (bindings ?? [])
      .filter(
        (binding: ResourceBinding<TemplateBinding> & { action?: string }) =>
          binding.action !== "delete",
      )
      .flatMap((binding) => binding.data?.volumes ?? [])
      .map(
        (mount) => [mount.path, { volume: { name: mount.volume.name }, path: mount.path }] as const,
      ),
  ).values(),
];

/** The mount clients the template's bindings need. */
const boundCapabilities = (
  bindings: ReadonlyArray<ResourceBinding<TemplateBinding>> | undefined,
): ReadonlyArray<MountCapability> =>
  collectMountCapabilities(
    (bindings ?? [])
      .filter(
        (binding: ResourceBinding<TemplateBinding> & { action?: string }) =>
          binding.action !== "delete",
      )
      .map((binding) => ({ data: { mounts: binding.data?.mounts ?? [] } })),
  );

/** What an E2B sandbox's kernel offers mount clients (checked live: `/dev/fuse`, nfs/nfs4, CAP_SYS_ADMIN). */
const E2B_MOUNT_SUPPORT = { fuse: true, nfs: true } as const;

const boundEnv = (bindings: ReadonlyArray<ResourceBinding<TemplateBinding>> | undefined) =>
  (bindings ?? [])
    .filter(
      (binding: ResourceBinding<TemplateBinding> & { action?: string }) =>
        binding.action !== "delete",
    )
    .reduce<Record<string, unknown>>((env, binding) => ({ ...env, ...binding.data?.env }), {});

/**
 * Plans a template's build: its Dockerfile or program lowered through
 * `BuildPlan`, then its own E2B steps.
 */
const planOf = Effect.fn(function* (
  name: string,
  news: TemplateProps,
  bindings: ReadonlyArray<ResourceBinding<TemplateBinding>> | undefined,
) {
  const { main, handler, port, build, env, dockerfile, context, image, ...steps } = news;
  const programPort = port ?? DEFAULT_PORT;
  const { args, ...bundle } = build ?? {};
  let lowered: LoweredSource | undefined;
  const capabilities = boundCapabilities(bindings);
  const unsupported = checkMountSupport("E2B.Template", capabilities, E2B_MOUNT_SUPPORT);
  if (unsupported !== undefined) return yield* unsupported;
  if (main !== undefined) {
    // The program, on `image` / `dockerfile` as its environment.
    lowered = yield* planSource(
      {
        main,
        ...(handler !== undefined ? { handler } : {}),
        ...(image !== undefined ? { image } : {}),
        ...(dockerfile !== undefined ? { dockerfile } : {}),
        ...(context !== undefined ? { context } : {}),
        build: bundle,
      },
      {
        port: programPort,
        ...(args !== undefined ? { args } : {}),
        install: mountInstallLines(capabilities),
        ...((news as { isExternal?: boolean }).isExternal
          ? {}
          : { bootstrap: makeBootstrap(handler ?? "default") }),
      },
    );
  } else if (dockerfile !== undefined || context !== undefined) {
    if (image !== undefined) {
      return yield* new E2BUnexpectedResponse({
        message: `template ${name}: set one of image or dockerfile`,
      });
    }
    lowered = yield* planSource(
      {
        ...(dockerfile !== undefined ? { dockerfile } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(args !== undefined ? { build: { args } } : {}),
      },
      args !== undefined ? { args } : {},
    );
  }
  const spec = {
    ...steps,
    ...(lowered === undefined && image !== undefined ? { image } : {}),
    name,
    env:
      main === undefined
        ? yield* plainEnv(env)
        : yield* programEnv(programPort, { ...mountEnv(capabilities), ...boundEnv(bindings) }, env),
    ...(main !== undefined ? { readyCmd: steps.readyCmd ?? programReadyCmd(programPort) } : {}),
  } satisfies TemplateBuildSpec;
  return { spec, plan: yield* planTemplateBuild(spec, lowered) };
});

/** `env` for a template without a program: plain values only. */
const plainEnv = (env: Readonly<Record<string, unknown>> | undefined) =>
  Effect.succeed(
    env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(env).flatMap(([key, value]) =>
            Redacted.isRedacted(value)
              ? [[key, String(Redacted.value(value))]]
              : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                ? [[key, String(value)]]
                : [],
          ),
        ),
  );

export const TemplateProvider = () =>
  Provider.effect(
    Template,
    Effect.gen(function* () {
      return {
        stables: ["templateId", "name"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) return { action: "replace" } as const;
          if (output === undefined) return undefined;
          // The plan hash reads the build context, so a changed file under an
          // unchanged `context` path still rebuilds.
          // Bindings may be unresolved here; the engine reconciles when they
          // change. Diff compares the hash of everything else.
          const { plan } = yield* planOf(name, news, undefined);
          if (plan.hash !== output.sourceHash || news.force) return { action: "update" } as const;
          if ((news.public ?? false) !== output.public) return { action: "update" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          // E2B's public defaults (`base`, `code-interpreter-v1`, …) can't be
          // read by alias (403 "You don't have access to this template
          // alias"); they are listed instead.
          const defaults = yield* templates.listDefaultTemplates({});
          const template =
            defaults.find(
              (candidate) =>
                candidate.aliases.includes(name) ||
                candidate.names.some((full) => full === name || full.split(":")[0] === name),
            ) ?? (yield* observeTemplate(undefined, name));
          if (template === undefined) return undefined;
          return {
            templateId: template.templateID,
            name,
            buildId: template.buildID,
            buildHash: "",
            sourceHash: "",
            names: [...template.names],
            public: template.public,
            cpuCount: template.cpuCount,
            memoryMB: template.memoryMB,
            mounts: [],
          } satisfies TemplateAttributes;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const template = yield* observeTemplate(output?.templateId, name);
          if (template === undefined) return undefined;
          const attrs: TemplateAttributes = {
            templateId: template.templateID,
            name,
            buildId: template.buildID,
            buildHash: output?.buildHash ?? "",
            sourceHash: output?.sourceHash ?? "",
            names: [...template.names],
            public: template.public,
            cpuCount: template.cpuCount,
            memoryMB: template.memoryMB,
            mounts: output?.mounts ?? [],
          };
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const name = output?.name ?? (yield* e2bName(id, news.name));
          const { spec, plan } = yield* planOf(name, news, bindings);

          // Observe
          const observed = yield* observeTemplate(output?.templateId, name);
          const sourceHash =
            bindings === undefined || bindings.length === 0
              ? plan.hash
              : (yield* planOf(name, news, undefined)).plan.hash;

          // Ensure — build when there is no ready build of these exact inputs.
          let attrs: TemplateAttributes;
          const upToDate =
            observed !== undefined &&
            observed.buildStatus === "ready" &&
            output?.buildHash === plan.hash &&
            !news.force;
          if (upToDate) {
            attrs = {
              templateId: observed.templateID,
              name,
              buildId: observed.buildID,
              buildHash: plan.hash,
              sourceHash,
              names: [...observed.names],
              public: observed.public,
              cpuCount: observed.cpuCount,
              memoryMB: observed.memoryMB,
              mounts: boundMounts(bindings),
            };
          } else {
            yield* session.note(`Building template ${name}...`);
            const built = yield* runTemplateBuild(spec, plan);
            attrs = {
              templateId: built.templateId,
              name,
              buildId: built.buildId,
              buildHash: plan.hash,
              sourceHash,
              names: [...built.names],
              public: built.public,
              cpuCount: news.cpuCount,
              memoryMB: news.memoryMB,
              mounts: boundMounts(bindings),
            };
          }

          // Sync — visibility.
          const desiredPublic = news.public ?? false;
          if (attrs.public !== desiredPublic) {
            yield* templates.updateTemplate({
              templateID: attrs.templateId,
              public: desiredPublic,
            });
            attrs = { ...attrs, public: desiredPublic };
          }
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // E2B refuses while sandboxes run on the template. A declared
          // sandbox is deleted first, so retry a while; sandboxes created at
          // run time are not deleted with the stack and keep failing it
          // until they are killed or time out.
          yield* templates.deleteTemplate({ templateID: output.templateId }).pipe(
            Effect.retry({
              while: (error) => error._tag === "TemplateInUse",
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        list: Effect.fn(function* () {
          const all = Array.from(
            yield* Stream.runCollect(templates.listTemplates.items({ limit: 100 })),
          );
          return all
            .filter((template) => template.aliases.some(isGeneratedName))
            .map((template): TemplateAttributes => ({
              templateId: template.templateID,
              name: template.aliases.find(isGeneratedName) ?? template.templateID,
              buildId: template.buildID,
              buildHash: "",
              sourceHash: "",
              names: [...template.names],
              public: template.public,
              cpuCount: template.cpuCount,
              memoryMB: template.memoryMB,
              mounts: [],
            }));
        }),
      };
    }),
  );
