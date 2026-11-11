import * as fs from "node:fs";
import * as path from "node:path";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Database } from "../Database.ts";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import type { PoolHost } from "../internal/PoolHostService.ts";
import type { Providers } from "../Providers.ts";

export interface ProcessPoolOptions extends PoolSettings {
  /**
   * The directory the pool writes its runner to: `runner.mjs`, the bundled
   * program, and `runner.env`, the environment every runner needs (it holds
   * the database URL and the gateway token, so it is readable by its owner
   * only). Start each runner with `node runner.mjs` and that environment,
   * e.g. a systemd unit with `EnvironmentFile=`.
   */
  dir: string;
  /**
   * Where callers reach the gateway the runners serve.
   * @default `http://127.0.0.1:${GATEWAY_PORT}`
   */
  gatewayUrl?: string;
}

/**
 * Run a pool of Effect Cluster runners as plain processes on hosts you run.
 * The pool declares nothing in the cloud: it writes the runner program and
 * its environment to {@link ProcessPoolOptions.dir}, and the host's process
 * manager starts the runners. Runners find each other through the database,
 * so any `Cluster.Database` the hosts reach will do.
 *
 * ### Running entities under systemd
 * **Example:** A pool written to a directory systemd runs it from
 * ```typescript
 * export const Database = Cluster.Database.fromUrl({
 *   url: Config.Redacted("CLUSTER_DATABASE_URL"),
 * });
 * export const Default = ClusterProcess.ProcessPool("Default", {
 *   dir: "/srv/cluster/default",
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const ProcessPool = (
  id: string,
  options: ProcessPoolOptions,
): Layer.Layer<PoolHost, never, Database | Stack | Providers> =>
  makePoolLayer({
    label: "ClusterProcess.ProcessPool",
    id,
    settings: options,
    expected: "any network its hosts reach",
    // Runners run on hosts you run: they reach the database however those hosts do.
    network: () => ({}),
    gateway: () =>
      Effect.succeed({ url: options.gatewayUrl ?? `http://127.0.0.1:${GATEWAY_PORT}` }),
    nodes: ({ program, environment }) =>
      ProcessRunners(`${id}Runners`, {
        dir: path.resolve(options.dir),
        program: program.pipe(Output.map((p) => p.dir)) as unknown as string,
        hash: program.pipe(Output.map((p) => p.hash)) as unknown as string,
        environment: environment as unknown as Record<string, string>,
      }).pipe(Effect.asVoid),
  });

export interface ProcessRunnersProps {
  /** Where to write `runner.mjs` and `runner.env`. */
  dir: string;
  /** The bundled program's directory. */
  program: string;
  /** The program's hash: a new hash rewrites the runner. */
  hash: string;
  /** The environment every runner needs. */
  environment: Record<string, string>;
}

export interface ProcessRunnersAttributes {
  /** The runner program. */
  runner: string;
  /** The runner's environment, one `KEY="value"` per line. */
  envFile: string;
  /** The program's hash. */
  hash: string;
}

export interface ProcessRunners extends Resource<
  "Cluster.ProcessRunners",
  ProcessRunnersProps,
  ProcessRunnersAttributes,
  never,
  Providers
> {}

/**
 * The runner program and environment a {@link ProcessPool} writes for the
 * host's process manager.
 *
 * @internal
 */
export const ProcessRunners = Resource<ProcessRunners>("Cluster.ProcessRunners");

/** A value quoted for a systemd `EnvironmentFile=` (and a shell's `set -a; . file`). */
const quote = (value: string) => `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;

const files = (dir: string) => ({
  runner: path.join(dir, "runner.mjs"),
  envFile: path.join(dir, "runner.env"),
});

export const ProcessRunnersProvider = () =>
  Provider.succeed(ProcessRunners, {
    reconcile: ({ news }) =>
      Effect.sync(() => {
        const { runner, envFile } = files(news.dir);
        fs.mkdirSync(news.dir, { recursive: true });
        fs.copyFileSync(path.join(news.program, "runner.mjs"), runner);
        const lines = Object.entries(news.environment).map(([k, v]) => `${k}=${quote(v)}`);
        fs.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
        // `mode` applies only when the file is created.
        fs.chmodSync(envFile, 0o600);
        return { runner, envFile, hash: news.hash };
      }),
    delete: ({ olds }) =>
      Effect.sync(() => {
        const { runner, envFile } = files(olds.dir);
        fs.rmSync(runner, { force: true });
        fs.rmSync(envFile, { force: true });
      }),
  });
