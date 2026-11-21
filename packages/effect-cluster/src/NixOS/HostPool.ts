import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Database } from "../Database.ts";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import type { PoolHost } from "../internal/PoolHostService.ts";
import type { Providers } from "../Providers.ts";

export interface HostPoolOptions extends PoolSettings {
  /**
   * The pool's name: the attribute of `services.effect-cluster.pools` the
   * host's NixOS configuration enables for it, and its unit
   * `effect-cluster-<name>.service`.
   */
  name: string;
  /**
   * The NixOS host, as `ssh` reaches it: `root@203.0.113.7` or a `Host`
   * from your SSH config. The user must be root, or a Nix trusted user
   * with `sudo` (set {@link HostPoolOptions.sudo}).
   */
  host: string;
  /**
   * Run the activation on the host with `sudo -n`.
   * @default false
   */
  sudo?: boolean;
  /** More `ssh` options, e.g. `["-p", "2222"]`. Also used by `nix copy`. */
  sshOptions?: string[];
  /**
   * Where callers reach the gateway the runner serves.
   * @default `http://127.0.0.1:${GATEWAY_PORT}`
   */
  gatewayUrl?: string;
}

/**
 * Run a pool of Effect Cluster runners on a NixOS host, with no Docker
 * and no package manager. The host's configuration declares the runner
 * service once, with the module this package ships (`nix/module.nix`,
 * `services.effect-cluster.pools.<name>`). Each deploy adds the bundled
 * runner to the local Nix store, copies it to the host with `nix copy`,
 * writes the runner's environment (mode 0600, outside the store), sets the
 * host's profile `/nix/var/nix/profiles/effect-cluster/<name>` to the new
 * runner and restarts the service. Each deploy is a new profile
 * generation, so a rollback is `nix-env --rollback` on that profile.
 *
 * Needs `nix` and `ssh` on the machine that deploys.
 *
 * ### Running entities on NixOS
 * **Example:** One runner, with PostgreSQL on the same host
 * ```typescript
 * export const Database = Cluster.Database.fromUrl({
 *   url: Redacted.make("postgres://effect-cluster-orders@localhost/effect-cluster-orders?host=/run/postgresql"),
 * });
 * export const Default = ClusterNixOS.HostPool("Default", {
 *   name: "orders",
 *   host: "root@203.0.113.7",
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const HostPool = (
  id: string,
  options: HostPoolOptions,
): Layer.Layer<PoolHost, never, Database | Stack | Providers> =>
  makePoolLayer({
    label: "ClusterNixOS.HostPool",
    id,
    settings: options,
    expected: "any network its host reaches",
    // The runner runs on a host you run: it reaches the database however that host does.
    network: () => ({}),
    gateway: () =>
      Effect.succeed({ url: options.gatewayUrl ?? `http://127.0.0.1:${GATEWAY_PORT}` }),
    nodes: ({ program, environment }) =>
      NixOSRunners(`${id}Runners`, {
        name: options.name,
        host: options.host,
        sudo: options.sudo ?? false,
        sshOptions: options.sshOptions ?? [],
        program: program.pipe(Output.map((p) => p.dir)) as unknown as string,
        hash: program.pipe(Output.map((p) => p.hash)) as unknown as string,
        environment: environment as unknown as Record<string, string>,
      }).pipe(Effect.asVoid),
  });

export interface NixOSRunnersProps {
  /** The pool's name on the host. */
  name: string;
  /** The `ssh` destination. */
  host: string;
  /** Activate with `sudo -n`. */
  sudo: boolean;
  /** More `ssh` options. */
  sshOptions: string[];
  /** The bundled program's directory. */
  program: string;
  /** The program's hash: a new hash deploys a new runner. */
  hash: string;
  /** The environment every runner needs. */
  environment: Record<string, string>;
}

export interface NixOSRunnersAttributes {
  /** The runner's store path, which holds `runner.mjs`. */
  storePath: string;
  /** The host's profile that points at {@link storePath}. */
  profile: string;
  /** The systemd unit that runs the runner. */
  unit: string;
  /** The program's hash. */
  hash: string;
}

export interface NixOSRunners extends Resource<
  "Cluster.NixOSRunners",
  NixOSRunnersProps,
  NixOSRunnersAttributes,
  never,
  Providers
> {}

/**
 * The runner a {@link HostPool} copies to its NixOS host and activates.
 *
 * @internal
 */
export const NixOSRunners = Resource<NixOSRunners>("Cluster.NixOSRunners");

/** A command `nix`, `ssh` or the host's activation failed. */
export class NixOSDeployError extends Data.TaggedError("Cluster.NixOSDeployError")<{
  readonly message: string;
}> {}

/** Run `command` with `args`, write `input` to its stdin, and resolve to its stdout. */
const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  Effect.callback<string, NixOSDeployError>((resume) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      resume(Effect.fail(new NixOSDeployError({ message: `${command}: ${error.message}` }))),
    );
    child.on("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(stdout.trim())
          : Effect.fail(
              new NixOSDeployError({
                message: `${command} exited ${code}: ${stderr.trim() || stdout.trim() || "no output"}`,
              }),
            ),
      ),
    );
    child.stdin.end(options.input ?? "");
  });

/** A string as one POSIX shell word. */
const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A value quoted for a systemd `EnvironmentFile=`. */
const quote = (value: string) => `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;

const PROFILES = "/nix/var/nix/profiles/effect-cluster";

const names = (name: string) => ({
  profile: `${PROFILES}/${name}`,
  unit: `effect-cluster-${name}.service`,
  envFile: `/var/lib/effect-cluster/${name}/runner.env`,
});

/** A pool name is a path segment and a unit name on the host. */
const checkName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
    ? Effect.void
    : Effect.fail(
        new NixOSDeployError({ message: `Pool name '${name}' is not a valid unit name.` }),
      );

const ssh = (
  props: Pick<NixOSRunnersProps, "host" | "sshOptions">,
  script: string,
  input?: string,
) => run("ssh", [...props.sshOptions, "-o", "BatchMode=yes", props.host, script], { input });

/** Add the runner program to the local store, as its own content-addressed path. */
const addToStore = (props: NixOSRunnersProps) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-nixos-"))),
    (tmp) =>
      Effect.gen(function* () {
        const dir = path.join(tmp, `effect-cluster-${props.name}`);
        yield* Effect.sync(() => {
          fs.mkdirSync(dir);
          fs.copyFileSync(path.join(props.program, "runner.mjs"), path.join(dir, "runner.mjs"));
        });
        return yield* run("nix-store", ["--add", dir]);
      }),
    (tmp) => Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true })),
  );

export const NixOSRunnersProvider = () =>
  Provider.succeed(NixOSRunners, {
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        yield* checkName(news.name);
        const { profile, unit, envFile } = names(news.name);
        const storePath = yield* addToStore(news);
        yield* run(
          "nix",
          [
            "--extra-experimental-features",
            "nix-command",
            "copy",
            "--to",
            `ssh-ng://${news.host}`,
            storePath,
          ],
          { env: { ...process.env, NIX_SSHOPTS: news.sshOptions.join(" ") } },
        );
        const sudo = news.sudo ? "sudo -n " : "";
        // The environment goes over stdin: it holds the database URL and the gateway token.
        const env = Object.entries(news.environment)
          .map(([key, value]) => `${key}=${quote(value)}\n`)
          .join("");
        yield* ssh(
          news,
          `${sudo}sh -euc ${sh(
            [
              `systemctl cat ${unit} >/dev/null 2>&1 || { echo "${unit} not found: enable services.effect-cluster.pools.${news.name} in the host's NixOS configuration" >&2; exit 3; }`,
              // The runner's user reads its program through the profile.
              `install -d -m 0755 ${PROFILES}`,
              `install -d -m 0700 ${sh(path.posix.dirname(envFile))}`,
              `umask 077`,
              `cat > ${sh(`${envFile}.new`)}`,
              `mv ${sh(`${envFile}.new`)} ${sh(envFile)}`,
              `nix-env -p ${sh(profile)} --set ${sh(storePath)}`,
              `systemctl restart ${unit}`,
            ].join("\n"),
          )}`,
          env,
        );
        return { storePath, profile, unit, hash: news.hash };
      }),
    delete: ({ olds }) =>
      Effect.gen(function* () {
        const { profile, unit, envFile } = names(olds.name);
        const sudo = olds.sudo ? "sudo -n " : "";
        // The unit stays declared on the host; with no profile it does not start.
        yield* ssh(
          olds,
          `${sudo}sh -euc ${sh(
            [
              `systemctl stop ${unit} || true`,
              `rm -f ${sh(profile)} ${sh(profile)}-*-link ${sh(envFile)}`,
            ].join("\n"),
          )}`,
        );
      }),
  });
