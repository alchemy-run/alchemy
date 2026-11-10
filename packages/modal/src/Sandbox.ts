import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as image from "@distilled.cloud/modal/image";
import * as secret from "@distilled.cloud/modal/secret";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { deepEqual, isResolved } from "alchemy/Diff";
import { mountInstallLines } from "alchemy/Mount";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { App } from "./App.ts";
import { buildImage, ImageBuildOps } from "./ImageBuild.ts";
import { checkCommands, lowerPlan, MODAL_CAPABILITIES } from "./ImagePlan.ts";
import { envNameOf, objectName } from "./internal.ts";
import { resolveDeclarations } from "./internal/Declared.ts";
import {
  boundCapabilities,
  boundMounts,
  checkModalMounts,
  type ModalMounts,
  type Mount,
  type MountBindings,
  type MountContract,
  modalMountsOf,
} from "./Mounts.ts";
import type { Providers } from "./Providers.ts";
import { putSecret } from "./Secret.ts";

const DEFAULT_PORT = 8080;

type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface SandboxProps extends PlatformProps {
  /**
   * Module entrypoint, bundled and baked into the sandbox image. Typically
   * `import.meta.url`. A change to the bundle builds a new image.
   */
  main: string;
  /** The App sandboxes run in. */
  app: Ref<App>;
  /**
   * Base image the bundle runs on. It needs Bun on the `PATH`.
   * @default "oven/bun:1"
   */
  image?: string;
  /** Dockerfile lines run on the base before the bundle is added. */
  commands?: string[];
  /**
   * Port the program's `fetch` handler listens on, opened as an encrypted
   * tunnel on every sandbox.
   * @default 8080
   */
  port?: number;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Extra environment variables for the program. Stored, with the
   * bindings' env, in a Modal Secret attached to every sandbox.
   */
  env?: Record<string, any>;
  /** Bundler options. */
  build?: Bundle.BundleConfig;
  /**
   * Volumes and cloud buckets mounted into every sandbox:
   * `[{ volume: Data, path: "/data" }]`. `Modal.MountVolume` and
   * `Modal.MountBucket` in the program add more.
   */
  mounts?: Mount[];
}

export interface SandboxAttributes {
  /** The image with the bundled program (`im-…`). */
  imageId: string;
  /** The App sandboxes run in. */
  appId: string;
  /** Name of the App. */
  appName: string | undefined;
  /** Environment of the App. */
  environment: string | undefined;
  /** The Modal Secret holding the program's env (bindings' credentials included). */
  secretId: string;
  /** Name of that secret. */
  secretName: string;
  /** Port the program listens on. */
  port: number;
  /** The command each sandbox runs. */
  command: string[];
  /** Modal's volume and bucket mounts every sandbox gets (props and bindings). */
  mounts: ModalMounts;
  /** Content hash of the bundle and image inputs. */
  hash: string;
}

export type Sandbox = Resource<
  "Modal.Sandbox",
  SandboxProps,
  SandboxAttributes,
  { env?: Record<string, any>; mounts?: MountContract },
  Providers
>;

export type SandboxServices = ServerHost;
export type SandboxShape = Main<SandboxServices>;
export type SandboxRuntimeContext = HostRuntimeContext;

/**
 * An Effect program that runs in Modal sandboxes. Alchemy bundles `main`,
 * builds it into an image on Modal's builder (no Docker), and stores its
 * env, including the credentials its bindings need, in a Modal Secret.
 * `Modal.CreateSandbox(Agent)` then boots sandboxes that run the program and
 * serve its `fetch` handler; `sandbox.getTcpPort()` reaches it.
 *
 * Each sandbox is an isolated instance: give one to every user, session or
 * task, and terminate it when the work is done. A sandbox lives at most 24
 * hours. Bindings work inside it like on any host, so the program can read a
 * Modal Volume or a Cloudflare R2 bucket.
 *
 * ### Effect program
 * **Example:** An agent that answers over HTTP
 * ```typescript
 * // src/Agent.ts
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Coder } from "./Coder.ts";
 *
 * export default class Agent extends Modal.Sandbox<Agent>()(
 *   "Agent",
 *   { main: import.meta.url, app: Coder },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ready")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async program
 * **Example:** A plain HTTP server, no Effect (it runs on Bun)
 * ```typescript
 * // src/Agent.ts
 * import * as Modal from "@alchemy.run/modal";
 * import { Coder } from "./Coder.ts";
 *
 * export const Agent = Modal.Sandbox("Agent", {
 *   main: "./src/agent-server.ts",
 *   app: Coder,
 *   env: { GREETING: "hello" },
 * });
 * export type AgentEnv = Modal.InferEnv<typeof Agent>;
 * ```
 *
 * ```typescript
 * // src/agent-server.ts
 * import { createServer } from "node:http";
 * import type { AgentEnv } from "./Agent.ts";
 *
 * const env = process.env as unknown as AgentEnv;
 *
 * createServer((_request, response) => response.end(env.GREETING)).listen(Number(process.env.PORT));
 * ```
 *
 * ### Starting instances
 * **Example:** One sandbox per request from a Worker
 * ```typescript
 * // src/Api.ts
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpClientRequest from "effect/http/HttpClientRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import Agent from "./Agent.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const agents = yield* Modal.CreateSandbox(Agent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const agent = yield* agents.create({ timeout: "10 minutes" });
 *         const port = yield* agent.getTcpPort();
 *         const response = yield* port.fetch(HttpClientRequest.get("/"));
 *         const text = yield* response.text;
 *         yield* agent.terminate();
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * ### Bindings inside the sandbox
 * **Example:** Read a Modal Volume from the program
 * ```typescript
 * // src/Agent.ts
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Coder, Models } from "./Coder.ts";
 *
 * export default class Agent extends Modal.Sandbox<Agent>()(
 *   "Agent",
 *   { main: import.meta.url, app: Coder },
 *   Effect.gen(function* () {
 *     const models = yield* Modal.ReadVolume(Models);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const files = yield* models.listFiles("/");
 *         return yield* HttpServerResponse.json(files);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadVolumeHttp)),
 * ) {}
 * ```
 *
 * ### Configuration
 * **Example:** A GPU-ready base and a custom port
 * ```typescript
 * export default class Trainer extends Modal.Sandbox<Trainer>()(
 *   "Trainer",
 *   {
 *     main: import.meta.url,
 *     app: Coder,
 *     image: "nvidia/cuda:12.4.1-runtime-ubuntu22.04",
 *     commands: ["RUN apt-get update && apt-get install -y curl unzip && curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun"],
 *     port: 3000,
 *   },
 *   program,
 * ) {}
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const Sandbox: Platform<Sandbox, SandboxServices, SandboxShape, SandboxRuntimeContext> =
  Platform("Modal.Sandbox", {
    createRuntimeContext: createHostRuntimeContext("Modal.Sandbox"),
    // `{ app: Coder }` at module scope is an Effect: yield it so the App is
    // registered and `news.app` is resolved attributes at reconcile.
    transformProps: (_id, props) =>
      Effect.gen(function* () {
        if (globalThis.__ALCHEMY_RUNTIME__) return props;
        const app = Effect.isEffect(props.app)
          ? yield* props.app as Effect.Effect<App, never, Providers>
          : props.app;
        const mounts =
          props.mounts === undefined
            ? undefined
            : ((yield* resolveDeclarations(props.mounts)) as Mount[]);
        return { ...props, app, mounts };
      }),
  });

const bootstrapEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/modal/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

const appOf = (value: unknown) => {
  const rec = (value ?? {}) as { appId?: string; name?: string; environment?: unknown };
  return { appId: rec.appId ?? "", appName: rec.name, environment: envNameOf(rec.environment) };
};

/** An env value as a string, as the program's `process.env` sees it. */
const envText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? String(Redacted.value(value))
      : JSON.stringify(value ?? null);

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      const stack = yield* Stack;

      /** Plan the program's image (bundle + bootstrap) with the shared BuildPlan. */
      const prepare = Effect.fn(function* (
        news: SandboxProps,
        port: number,
        bindings: MountBindings,
      ) {
        // Other providers' mount clients go into the image; Modal can't
        // provide FUSE or NFS, so those that need it fail here.
        const capabilities = boundCapabilities(bindings);
        yield* checkModalMounts("Modal.Sandbox", capabilities);
        const plan = yield* BuildPlan.plan(
          {
            main: news.main,
            image: news.image,
            handler: news.handler,
            build: news.build,
          },
          {
            capabilities: { ...MODAL_CAPABILITIES, target: "Modal.Sandbox" },
            port,
            bootstrap: news.isExternal ? undefined : bootstrapEntry(news.handler ?? "default"),
            install: mountInstallLines(capabilities),
          },
        );
        const extra = yield* checkCommands(news.commands ?? []);
        const spec = yield* lowerPlan(plan, extra);
        const hash = yield* sha256Object({ plan: plan.hash, extra });
        const command = BuildPlan.startCommand(plan) ?? [];
        return { spec, hash, command: [...command] };
      });

      return {
        stables: ["appId", "secretName"],
        diff: Effect.fn(function* ({ news, output, newBindings }) {
          if (!isResolved(news) || !isResolved(newBindings) || output === undefined) {
            return undefined;
          }
          if (appOf(news.app).appId !== output.appId) return { action: "replace" } as const;
          const { hash } = yield* prepare(news, news.port ?? DEFAULT_PORT, newBindings);
          if (hash !== output.hash) return { action: "update" } as const;
          const mounts = yield* modalMountsOf([
            ...(news.mounts ?? []),
            ...boundMounts(newBindings),
          ]);
          return deepEqual(mounts, output.mounts) ? undefined : ({ action: "update" } as const);
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* image
            .imageFromId({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
          return found?.imageId ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
          const app = appOf(news.app);
          // The props' mounts, then the ones `Modal.MountVolume` / `MountBucket` bound.
          const mounts = yield* modalMountsOf([...(news.mounts ?? []), ...boundMounts(bindings)]);
          const port = news.port ?? DEFAULT_PORT;
          const secretName = output?.secretName ?? `${yield* objectName(id, undefined, 58)}-env`;

          // Sync the program's env (bindings' credentials included) into a
          // secret every sandbox attaches; values never enter the image.
          const env: Record<string, string> = {
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
            HOST: "0.0.0.0",
            PORT: String(port),
          };
          for (const [key, value] of Object.entries(news.env ?? {})) env[key] = envText(value);
          const stored = yield* putSecret(
            yield* secret.secretGetOrCreate,
            secretName,
            app.environment,
            env,
          );

          // Ensure the image: Modal reuses a cached build for the same inputs.
          const { spec, hash, command } = yield* prepare(news, port, bindings);
          const imageId =
            output !== undefined && output.hash === hash && output.appId === app.appId
              ? output.imageId
              : yield* buildImage(yield* ImageBuildOps, app.appId, spec, { note: session.note });

          return {
            imageId,
            appId: app.appId,
            appName: app.appName,
            environment: app.environment,
            secretId: stored.secretId,
            secretName,
            port,
            command,
            mounts,
            hash,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* secret
            .deleteSecret({ secretId: output.secretId })
            .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
          yield* image
            .deleteImage({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.void));
        }),
      };
    }),
  );
