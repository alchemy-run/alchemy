import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Output from "./Output.ts";
import { Platform, type Main, type PlatformProps } from "./Platform.ts";
import * as Provider from "./Provider.ts";
import type { Resource } from "./Resource.ts";
import { reifyBoundConfigProvider } from "./Runtime.ts";
import { entrypointLayer, entrypointTag, stackFromEnv } from "./Runtime/Bootstrap.ts";
import { createHostRuntimeContext, type HostRuntimeContext } from "./Runtime/Process.ts";
import { packEnvValueKeepRedacted, RuntimeContext } from "./RuntimeContext.ts";
import { Self } from "./Self.ts";
import { Stack } from "./Stack.ts";
import { makeWebhookRoutes, WebhookHost, type WebhookRoutes } from "./WebhookHost.ts";

export const ExternalProcessTypeId = "Alchemy.ExternalProcess";

export interface ExternalProcessProps extends PlatformProps {
  /**
   * The process's public base URL, without a trailing slash. Event sources
   * point their webhooks at it (see {@link WebhookHost}).
   */
  url?: string;
  /**
   * Also write {@link ExternalProcess.variables} to this file at deploy, as
   * double-quoted `KEY="value"` lines (a systemd `EnvironmentFile`, a
   * `.env` file). It is written with mode `0600` through a temporary file
   * and a rename, and deleted with the resource. It holds secrets in
   * plaintext: hand it to a secret store, never commit it.
   */
  envFile?: string;
  /** Extra environment variables for the process. */
  env?: Record<string, unknown>;
}

/**
 * A program that runs in a process Alchemy does not deploy: an existing
 * Node or Bun server, a NixOS or systemd service, a deployment of another
 * tool.
 *
 * At plan, the bindings its program yields record their values in the
 * process's environment, as on every other process host. Alchemy deploys
 * nothing: the resource's {@link ExternalProcess.variables} (and the
 * optional `envFile`) are the environment your own deploy gives the
 * process. In that process, {@link runtime} runs the same program and the
 * bindings read their values back from `process.env`.
 *
 * @resource
 */
export interface ExternalProcess extends Resource<
  "Alchemy.ExternalProcess",
  ExternalProcessProps,
  {
    url: string | undefined;
    /**
     * The process's environment: the values its bindings recorded, the
     * `env` prop, and the `ALCHEMY_*` variables {@link runtime} needs.
     * Secret values stay `Redacted`.
     */
    variables: Record<string, string | Redacted.Redacted<string>>;
    envFile: string | undefined;
  },
  { env?: Record<string, unknown> }
> {}

export type ExternalProcessServices = WebhookHost;
export type ExternalProcessShape = Main<ExternalProcessServices> | Record<string, unknown>;

export interface ExternalProcessRuntimeContext extends HostRuntimeContext {
  /** The webhook paths the program claimed through {@link WebhookHost}. */
  readonly routes: WebhookRoutes;
}

/** {@link WebhookHost} of an external process: its routes table. */
const ExternalWebhookHostLive = Layer.effect(
  WebhookHost,
  Effect.gen(function* () {
    const host = (yield* Self) as unknown as {
      readonly LogicalId: string;
      readonly url: Output.Output<string | undefined>;
      readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
    };
    const context = (yield* RuntimeContext) as ExternalProcessRuntimeContext;
    return WebhookHost.of({
      LogicalId: host.LogicalId,
      url: host.url,
      bind: (id, data) => host.bind(id, data),
      route: context.routes.route,
    });
  }),
);

const createRuntimeContext = (id: string): ExternalProcessRuntimeContext => {
  const base = createHostRuntimeContext(ExternalProcessTypeId)(id);
  const routes = makeWebhookRoutes(id);
  let shape: Record<string, unknown> | undefined;
  return Object.assign(base, {
    routes,
    // Keep the `Redacted` wrapper outside the packed string, so the
    // provider can keep secrets out of plan output.
    set: (bindingId: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
        base.env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    // The program's return value is what the process takes: keep it, and
    // start no server. `alwaysServe` hands it over even with no `fetch`.
    alwaysServe: true,
    serve: ((_handler, options) =>
      Effect.sync(() => {
        shape = options?.shape;
      })) as HostRuntimeContext["serve"],
    shape: () => shape ?? {},
    hostServices: ExternalWebhookHostLive,
  });
};

export const ExternalProcess: Platform<
  ExternalProcess,
  ExternalProcessServices,
  ExternalProcessShape,
  ExternalProcessRuntimeContext
> = Platform(ExternalProcessTypeId, { createRuntimeContext });

const pack = (value: unknown): string | Redacted.Redacted<string> =>
  typeof value === "string" ||
  (Redacted.isRedacted(value) && typeof Redacted.value(value) === "string")
    ? (value as string | Redacted.Redacted<string>)
    : packEnvValueKeepRedacted(value);

/** One `KEY="value"` line; `"`, `\` and line breaks are escaped. */
const envLine = (key: string, value: string | Redacted.Redacted<string>): string => {
  const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  const escaped = raw
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `${key}="${escaped}"`;
};

/** The file `envFile` names, as `ExternalProcess` writes it. */
export const formatEnvFile = (
  variables: Record<string, string | Redacted.Redacted<string>>,
): string =>
  Object.keys(variables)
    .sort()
    .map((key) => envLine(key, variables[key]!))
    .join("\n") + "\n";

/**
 * Provider of {@link ExternalProcess}. It makes no cloud call: it resolves
 * the process's environment and, with `envFile`, writes it to that file.
 *
 * @provider
 */
export const ExternalProcessProvider = () =>
  Provider.effect(
    ExternalProcess,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const writeEnvFile = Effect.fn(function* (
        file: string,
        variables: Record<string, string | Redacted.Redacted<string>>,
      ) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        yield* fs.writeFileString(temp, formatEnvFile(variables), { mode: 0o600 });
        // `writeFile` keeps the mode of a file that already exists.
        yield* fs.chmod(temp, 0o600);
        yield* fs.rename(temp, file);
      }, Effect.orDie);
      const removeEnvFile = Effect.fn(function* (file: string) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(file, { force: true });
      }, Effect.orDie);
      return {
        diff: () => Effect.succeed(undefined),
        reconcile: Effect.fn(function* ({ news, olds, bindings }) {
          const variables: Record<string, string | Redacted.Redacted<string>> = {
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
          };
          for (const binding of bindings) {
            if ((binding as { action?: string }).action === "delete") continue;
            for (const [key, value] of Object.entries(binding.data?.env ?? {})) {
              if (value !== undefined) variables[key] = pack(value);
            }
          }
          for (const [key, value] of Object.entries(news.env ?? {})) {
            if (value !== undefined) variables[key] = pack(value);
          }
          if (olds?.envFile !== undefined && olds.envFile !== news.envFile) {
            yield* removeEnvFile(olds.envFile);
          }
          if (news.envFile !== undefined) {
            yield* writeEnvFile(news.envFile, variables);
          }
          return { url: news.url, variables, envFile: news.envFile };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output?.envFile !== undefined) {
            yield* removeEnvFile(output.envFile);
          }
        }),
      };
    }),
  );

/** What {@link runtime} gives the process. */
export interface ExternalProcessRuntime<Shape> {
  /** The value the program returned (its bound clients, handlers, …). */
  readonly shape: Shape;
  /**
   * The response of the webhook handler that claimed the request's path,
   * or `undefined` when the request is the process's own.
   */
  readonly handle: (request: Request) => Effect.Effect<Response> | undefined;
}

/**
 * Run an {@link ExternalProcess} program in its own process. The bindings
 * read their values from `process.env`, which your deploy filled from
 * {@link ExternalProcess.variables}.
 *
 * Run it once, at process start. The program's services live in the ambient
 * `Scope`, so give it a scope that lives as long as the process and close
 * that scope at shutdown:
 *
 * ```typescript
 * const scope = Effect.runSync(Scope.make());
 * const api = await Effect.runPromise(ExternalProcess.runtime(Api).pipe(Scope.provide(scope)));
 * Bun.serve({ fetch: (req) => api.handle(req) ?? app(req, api.shape) });
 * ```
 *
 * The process must run in the runtime phase before the module that declares
 * the program loads: define `globalThis.__ALCHEMY_RUNTIME__` as `true` in the
 * app's bundler (as Alchemy's bundler does), or set it in the entry and
 * import the program after it. `runtime` fails without it.
 */
export const runtime = <Shape = Record<string, unknown>>(entrypoint: unknown) =>
  Effect.suspend(() => {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      return Effect.die(
        new Error(
          "ExternalProcess.runtime needs globalThis.__ALCHEMY_RUNTIME__ = true before the program's module loads",
        ),
      );
    }
    const layer = entrypointLayer(entrypoint).pipe(
      Layer.provideMerge(stackFromEnv),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
        ),
      ),
    );
    return Effect.flatMap(Effect.scope, (scope) => Layer.buildWithScope(layer, scope)).pipe(
      Effect.map((context): ExternalProcessRuntime<Shape> => {
        const self = Context.get(context, entrypointTag);
        const runtimeContext = self.RuntimeContext as ExternalProcessRuntimeContext;
        return {
          shape: (runtimeContext.shape?.() ?? {}) as Shape,
          handle: runtimeContext.routes.handle,
        };
      }),
    );
  });
