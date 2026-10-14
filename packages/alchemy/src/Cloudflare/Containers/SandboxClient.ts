/**
 * The Durable Object side of `Cloudflare.Containers.Sandbox`: an
 * `AI.Sandbox` declaration's client over the container bound to the
 * Durable Object. Provided to every Cloudflare Durable Object as the
 * `AI.SandboxRuntime`.
 */
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import {
  SandboxError,
  type SandboxClient,
  type SandboxHostDescriptor,
  type SandboxProcess,
  type SandboxStartOptions,
} from "../../AI/Sandbox.ts";
import { toHttpClient } from "../Fetcher.ts";
import type { ContainerStartupOptions } from "./Container.ts";
import {
  makeContainerHandle,
  type ContainerClient,
  type ContainerExecOptions,
  type ContainerProcess,
  type ContainerStartOptions,
} from "./ContainerClient.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

/** The `AI.SandboxHostDescriptor.host` of a Cloudflare Container host. */
export const CLOUDFLARE_CONTAINER_HOST = "Cloudflare.Container";

/** A Cloudflare Container instance type a sandbox size maps to. */
export type ContainerInstanceType = NonNullable<ContainerStartupOptions["instance"]>;

const CloudflareSandboxKey = Symbol.for("alchemy/Cloudflare/Containers/Sandbox");

/** @internal The container under a Cloudflare-hosted sandbox client. */
export interface CloudflareSandbox {
  readonly container: ContainerClient;
  /** `start({ size, … })` as the container's `start` options. */
  readonly startOptions: (options: SandboxStartOptions) => ContainerStartOptions;
}

/** @internal */
export const cloudflareSandboxOf = (sandbox: unknown): CloudflareSandbox | undefined =>
  typeof sandbox === "object" && sandbox !== null && CloudflareSandboxKey in sandbox
    ? (sandbox as { [CloudflareSandboxKey]: CloudflareSandbox })[CloudflareSandboxKey]
    : undefined;

/**
 * The Cloudflare Container under a sandbox hosted by
 * `Cloudflare.Containers.Sandbox`: snapshots, images, interception and the
 * rest of the native container API. Fails for a sandbox on another host.
 *
 * ### Reaching the native container
 * **Example:** Snapshot a sandbox's filesystem
 * ```typescript
 * const sandbox = yield* Sandbox;
 * const container = yield* Cloudflare.Containers.containerOf(sandbox);
 * const snapshot = yield* container.snapshotContainer();
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const containerOf = (
  sandbox: SandboxClient<any>,
): Effect.Effect<ContainerClient, SandboxError> => {
  const hosted = cloudflareSandboxOf(sandbox);
  return hosted
    ? Effect.succeed(hosted.container)
    : Effect.fail(
        new SandboxError({ message: "This sandbox is not hosted on a Cloudflare Container." }),
      );
};

const sandboxError = (cause: { readonly message: string }) =>
  new SandboxError({ message: cause.message, cause });

const fromProcess = (process: ContainerProcess): SandboxProcess => ({
  pid: process.pid,
  isPty: process.isPty,
  stdin: process.stdin?.pipe(Sink.mapError(sandboxError)),
  stdout: process.stdout?.pipe(Stream.mapError(sandboxError)),
  stderr: process.stderr?.pipe(Stream.mapError(sandboxError)),
  exitCode: process.exitCode.pipe(Effect.mapError(sandboxError)),
  output: () =>
    process.output().pipe(
      Effect.map((output) => ({
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: output.exitCode,
      })),
      Effect.mapError(sandboxError),
    ),
  kill: (signal) => process.kill(signal).pipe(Effect.mapError(sandboxError)),
  resize: (cols, rows) => process.resize(cols, rows).pipe(Effect.mapError(sandboxError)),
});

/** @internal A sandbox client over a container, with its sizes' instance types. */
export const fromContainerClient = (
  container: ContainerClient,
  sizes: Record<string, unknown>,
): SandboxClient => {
  const startOptions = (options: SandboxStartOptions): ContainerStartOptions => {
    const instance = sizes[options.size] as ContainerInstanceType | undefined;
    return {
      ...(instance !== undefined ? { instance } : {}),
      ...(options.egress !== undefined ? { egress: options.egress } : {}),
      ...(options.enableInternet !== undefined ? { enableInternet: options.enableInternet } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    } as ContainerStartOptions;
  };
  return {
    [CloudflareSandboxKey]: { container, startOptions },
    running: container.running.pipe(Effect.mapError(sandboxError)),
    start: (options) =>
      sizes[options.size] === undefined
        ? Effect.fail(new SandboxError({ message: `Unknown sandbox size '${options.size}'.` }))
        : container.start(startOptions(options)).pipe(Effect.mapError(sandboxError)),
    setEgress: ({ egress }) => container.setEgress(egress).pipe(Effect.mapError(sandboxError)),
    addEgress: (egress) => container.addEgress(egress).pipe(Effect.mapError(sandboxError)),
    removeEgress: (egress) => container.removeEgress(egress).pipe(Effect.mapError(sandboxError)),
    exec: (cmd, options) =>
      container
        .exec([...cmd], options as ContainerExecOptions | undefined)
        .pipe(Effect.map(fromProcess), Effect.mapError(sandboxError)),
    getTcpPort: (port) =>
      container.getTcpPort(port).pipe(
        Effect.map((tcp) => ({
          fetch: (request) =>
            tcp
              .fetch(request)
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "HttpClientError" ? error : sandboxError(error),
                ),
              ),
        })),
      ),
    httpClient: (port) =>
      container.getTcpPort(port).pipe(Effect.map((tcp) => toHttpClient(tcp as never))),
    stop: () => container.destroy().pipe(Effect.mapError(sandboxError)),
  } satisfies SandboxClient & { [CloudflareSandboxKey]: CloudflareSandbox } as SandboxClient;
};

/**
 * @internal Connect declaration `id` to the container bound to this Durable
 * Object (binding it at deploy time).
 */
export const connectCloudflareSandbox = (id: string, descriptor: SandboxHostDescriptor) =>
  Effect.gen(function* () {
    if (descriptor.host !== CLOUDFLARE_CONTAINER_HOST) {
      return yield* Effect.die(
        new SandboxError({
          message: `Sandbox '${id}' is hosted on '${descriptor.host}', which a Cloudflare Durable Object cannot reach yet.`,
        }),
      );
    }
    const tag = (ContainerPlatform as unknown as () => (id: string) => Effect.Effect<unknown>)()(
      id,
    );
    const container = (yield* makeContainerHandle(
      id,
      ContainerPlatform.bind(tag as never),
    )) as unknown as ContainerClient;
    return fromContainerClient(container, descriptor.sizes);
  });
