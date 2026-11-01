import {
  makeContainerImageSource,
  type ImageRegistryTarget,
} from "@alchemy.run/docker/ImageSource";
import type * as Bundle from "alchemy/Bundle/Bundle";
import type { ResourceBinding } from "alchemy/Resource";
import { createContainerRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FUNCTION_PLATFORM } from "../Functions/internal.ts";
import type { HostBinding } from "../StackitBindings.ts";
import { pushedDigestReference } from "./pushImage.ts";

/**
 * What STACKIT's runtimes that run a bun process from a built image share:
 * `Stackit.Functions.Function`, `Stackit.ContainerApplications.Application` and
 * `Stackit.CloudFoundry.App`.
 */

/** Where an image built from `main` is pushed. */
export interface HostRegistry {
  /**
   * Repository the image is pushed to, including the registry host and without a
   * tag: `registry.onstackit.cloud/my-project/api`, or, with a
   * `Stackit.ContainerRegistry.Project`, `${project.imagePrefix}/api`.
   */
  repository: string;
  /**
   * Login for the push. Omit `username` and `password` to push with the deploying
   * machine's own `docker login`.
   */
  username?: string;
  /** Password or token for the push. */
  password?: string | Redacted.Redacted<string>;
}

/**
 * Keep values as they are until `reconcile` turns them into container variables,
 * so a `Redacted` stays `Redacted` in the host's props and state. The stock
 * context packs them into plain strings here, which would put a service account
 * key in state as plain text. `get` still reads what `packEnvValue` writes.
 */
export const createRawEnvRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const base = createContainerRuntimeContext(type)(id);
    return Object.assign(base, {
      set: (bindingId: string, output: unknown) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          base.env[key] = output;
          return key;
        }),
    });
  };

/**
 * How long a host process gets to finish its work once told to stop. Below the shortest stop
 * window of the platforms that run one: Cloud Foundry's 10 seconds.
 */
const HOST_SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Generated entry of an effectful host: only `@alchemy.run/stackit/Bootstrap` and
 * the user's `main`. The runtime flag is raised before `main` evaluates, hence the
 * dynamic import.
 */
const effectEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/stackit/Bootstrap";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/**
 * Generated entry of an async host: a thin server with no Effect in it, which
 * hands each request to the handler with `process.env` as its second argument.
 */
const asyncEntry =
  (handler: string, resourceType: string, port: number) =>
  (importPath: string): string =>
    `
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});
const handler = typeof entrypoint === "function" ? entrypoint : entrypoint?.fetch;
if (typeof handler !== "function") {
  throw new Error(${JSON.stringify(`The ${handler} export of a ${resourceType} must be a function or have a fetch method`)});
}
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? ${String(port)}),
  fetch: (request) => handler(request, process.env),
});
const stop = () => {
  setTimeout(() => process.exit(1), ${String(HOST_SHUTDOWN_TIMEOUT_MS)}).unref();
  server.stop().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`;

/** The image source of a host built from `main`, for `hash` and `resolve` alike. */
export const hostImageSource = (args: {
  props: {
    handler?: string | undefined;
    image?: string | undefined;
    build?: Bundle.BundleConfig | undefined;
    isExternal?: boolean | undefined;
  };
  main: string;
  port: number;
  resourceType: string;
}) => {
  const { props, main, port, resourceType } = args;
  const handler = props.handler ?? "default";
  return {
    source: { main, handler: props.handler, image: props.image, build: props.build },
    port,
    platform: FUNCTION_PLATFORM,
    // Both forms get a generated entry: the async one is the thin server above,
    // so the image source must not treat `main` as already serving requests.
    isExternal: false,
    bootstrap:
      props.isExternal === true ? asyncEntry(handler, resourceType, port) : effectEntry(handler),
  };
};

/**
 * Build the program and push it, pinned by digest, unless what is deployed already
 * runs this exact program from this repository.
 */
export const pushHostImage = Effect.fn(function* (args: {
  id: string;
  source: ReturnType<typeof hostImageSource>;
  registry: HostRegistry;
  deployed:
    | { readonly image?: string | undefined; readonly codeHash?: string | undefined }
    | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}) {
  const { id, source, registry, deployed, session } = args;
  const images = yield* makeContainerImageSource;
  const codeHash = yield* images.hash(source);
  if (deployed?.codeHash === codeHash && deployed?.image?.startsWith(`${registry.repository}@`)) {
    return { image: deployed.image, codeHash };
  }
  const target: ImageRegistryTarget = {
    repositoryUri: Effect.succeed(registry.repository),
    // The digest comes from the push output, so the push always runs.
    hasTag: () => Effect.succeed(false),
    credentials: Effect.succeed(
      registry.username !== undefined && registry.password !== undefined
        ? {
            server: registry.repository.split("/")[0]!,
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    ),
  };
  const resolved = yield* images.resolve({ id, session, ...source }, target);
  const image = yield* pushedDigestReference({ id, imageUri: resolved.imageUri, registry });
  return { image, codeHash: resolved.codeHash };
});

/** A value as a container variable: raw for a plain process, packed for `Config`. */
export const hostEnvValue = (value: unknown, external: boolean): string => {
  if (!external) return packEnvValue(value);
  const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
};

/**
 * A variable as a container variable. `PORT` is always raw: core's HTTP server reads it through
 * `Config.Number`, and a number-shaped string comes out of {@link hostEnvValue} packed in quotes,
 * which fails to parse and stops the program from starting.
 */
export const hostEnvVariable = (name: string, value: unknown, external: boolean): string =>
  hostEnvValue(value, external || name === "PORT");

/**
 * The host's desired env: binding env, Alchemy's runtime env, then the user's. Only
 * the `env` of a binding applies: a host with no STACKIT identity can't take grants,
 * and `StackitBindings.Bind` puts them on a created service account.
 */
export const hostEnv = Effect.fn(function* (
  props: { env?: Record<string, unknown> | undefined },
  bindings: ReadonlyArray<ResourceBinding<HostBinding>>,
  external: boolean,
) {
  const stack = yield* Stack;
  const env: Record<string, unknown> = {
    ...Object.assign(
      {},
      ...bindings
        // A binding being removed no longer contributes.
        .filter(
          (binding: ResourceBinding<HostBinding> & { action?: string }) =>
            binding.action !== "delete",
        )
        .map((binding) => binding.data?.env),
    ),
    ...(external
      ? {}
      : {
          ALCHEMY_STACK_NAME: stack.name,
          ALCHEMY_STAGE: stack.stage,
          ALCHEMY_PHASE: "runtime",
        }),
    ...props.env,
  };
  return env;
});
