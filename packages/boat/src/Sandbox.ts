import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  boatName,
  hasAnyAlchemyLabel,
  hasOwnershipLabels,
  ownershipLabels,
  userLabels,
} from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/**
 * Machine size. `small` runs at half the default rate and `large` at
 * twice; `xlarge` needs the $100/month plan or higher.
 */
export type SandboxType = "small" | "default" | "large" | "xlarge";

export interface SandboxProps {
  /**
   * Display name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Renamed in place.
   */
  name?: string;
  /**
   * Machine size. Changing it replaces the sandbox.
   * @default "default"
   */
  type?: SandboxType;
  /**
   * Seconds the sandbox runs before Boat stops it, saving its disk; `null`
   * never stops it. Updated in place: the next stop is then `ttlSeconds`
   * from the deploy.
   * @default 3600
   */
  ttlSeconds?: number | null;
  /**
   * Environment variables for the sandbox, on top of its environment's.
   * Changing them replaces the sandbox.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * The Boat environment to attach, by name: its repositories, secrets and
   * credential settings. Omit for the account's default environment
   * (`base`). Changing it replaces the sandbox.
   */
  environment?: string;
  /**
   * Attach none of the account's secrets (no environment variables, secret
   * files or credentials), and confine the sandbox so it can't act on the
   * account. For sandboxes you give to your own users. Changing it replaces
   * the sandbox.
   * @default false
   */
  noEnv?: boolean;
  /**
   * `false` never snapshots the sandbox: stopping it erases its disk, and it
   * can't be resumed, forked or saved. Changing it replaces the sandbox.
   * @default true
   */
  snapshots?: boolean;
  /**
   * `false` keeps no command output, process list or metrics for the
   * sandbox. Changing it replaces the sandbox.
   * @default true
   */
  monitoring?: boolean;
  /**
   * A shell script run once, in the background, after the sandbox starts.
   * Its outcome is `setupStatus`. Changing it replaces the sandbox.
   */
  setupScript?: string;
  /**
   * Start from a saved snapshot, by name (a `Boat.Snapshot`'s `name`) or
   * share code (`bsh_…`). Changing it replaces the sandbox.
   */
  from?: string;
  /**
   * Your own labels, at most 17 (Alchemy adds three). Boat sets labels
   * only at create, so changing them replaces the sandbox.
   */
  labels?: Record<string, string>;
  /**
   * The sandbox's subdomain under `on.boat.dev`. Port `p` answers at
   * `https://<subdomain>-<p>.on.boat.dev`. Renamed in place.
   */
  subdomain?: string;
}

export interface SandboxAttributes {
  /** Boat's sandbox id (`bx_…`). */
  sandboxId: string;
  name: string;
  /** `ready`, `running`, `idle`, `archived` (stopped), … */
  state: boat.SandboxState;
  type: SandboxType | undefined;
  /** vCPUs and RAM (GB) the machine size guarantees. */
  vcpu: number | undefined;
  memoryGB: number | undefined;
  /**
   * The subdomain its ports are served under: port `p` answers at
   * `https://<subdomain>-<p>.on.boat.dev`.
   */
  subdomain: string | undefined;
  /** The machine's URL. */
  url: string | undefined;
  /** The environment the sandbox runs, and its version. */
  environment: string | undefined;
  environmentVersion: number | undefined;
  /** Seconds it runs before stopping, or `undefined` when it never stops. */
  ttlSeconds: number | undefined;
  /** Your labels, without Alchemy's. */
  labels: Record<string, string>;
  /** The setup script's outcome: `pending`, `running`, `done` or `failed`. */
  setupStatus: boat.SandboxSetupStatus | undefined;
}

export interface Sandbox extends Resource<
  "Boat.Sandbox",
  SandboxProps,
  SandboxAttributes,
  never,
  Providers,
  { sandboxId: string }
> {}

/**
 * A Boat sandbox the stack owns: a Linux machine with Docker, passwordless
 * `sudo` and a desktop, that stops itself after `ttlSeconds` and keeps its
 * disk until it is resumed.
 *
 * Use it for a workspace that outlives requests (an agent's home, a dev
 * box, a preview environment). Bindings create short-lived sandboxes at
 * run time with `Boat.CreateSandbox`.
 *
 * Alchemy labels the sandbox with its stack, stage and logical ID
 * (`alchemy.stack`, `alchemy.stage`, `alchemy.id`) to recognise the
 * sandboxes it owns.
 *
 * :::caution
 * Replacing the sandbox (a new `type`, `env`, `environment`, `noEnv`,
 * `snapshots`, `monitoring`, `setupScript`, `from` or `labels`) creates a
 * fresh sandbox and deletes the old one with its disk.
 * :::
 *
 * ### Creating a Sandbox
 * **Example:** A dev box that stops after an idle hour
 * ```typescript
 * import * as Boat from "@alchemy.run/boat";
 *
 * export const DevBox = Boat.Sandbox("DevBox", {
 *   type: "large",
 *   ttlSeconds: 3600,
 *   setupScript: "git clone https://github.com/alchemy-run/alchemy ~/alchemy",
 * });
 * ```
 *
 * **Example:** A sandbox with none of the account's secrets
 * ```typescript
 * export const Untrusted = Boat.Sandbox("Untrusted", {
 *   noEnv: true,
 *   env: { TASK: "lint" },
 * });
 * ```
 *
 * ### Starting from a snapshot
 * **Example:** Boot from a saved snapshot
 * ```typescript
 * const golden = yield* Boat.Snapshot("Golden", { sandbox: Builder });
 * const box = yield* Boat.Sandbox("Box", { from: golden.name });
 * ```
 *
 * ### Using it at runtime
 * **Example:** Run a command in it from a Worker
 * ```typescript
 * const devBox = yield* Boat.ConnectSandbox(DevBox);
 * // in fetch:
 * yield* devBox.resume();
 * const result = yield* devBox.exec("git pull && npm test", { cwd: "/home/user/repo" });
 * ```
 *
 * ### Referencing a sandbox the stack doesn't manage
 * **Example:** Look one up by id
 * ```typescript
 * const shared = Boat.Sandbox.lookup({ sandboxId: "bx_abc123" });
 * const box = yield* Boat.ConnectSandbox(shared);
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const Sandbox = Resource<Sandbox>("Boat.Sandbox");

/** A sandbox, or `undefined` when Boat no longer has it. */
export const observeSandbox = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((got) =>
      got.sandbox === undefined || got.sandbox.state === "cancelled" ? undefined : got.sandbox,
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Delete a sandbox; deleting one that is gone succeeds. */
export const deleteSandbox = (sandboxId: string) =>
  boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

const plainEnv = (env: SandboxProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

export const toAttributes = (sandbox: boat.Sandbox): SandboxAttributes => ({
  sandboxId: sandbox.id,
  name: sandbox.name,
  state: sandbox.state,
  type: sandbox.type,
  vcpu: sandbox.vcpu,
  memoryGB: sandbox.memoryGB,
  subdomain: sandbox.subdomain ?? undefined,
  url: sandbox.url ?? undefined,
  environment: sandbox.environment ?? undefined,
  environmentVersion: sandbox.environmentVersion ?? undefined,
  ttlSeconds: sandbox.ttlSeconds ?? undefined,
  labels: userLabels(sandbox.labels),
  setupStatus: sandbox.setupStatus ?? undefined,
});

/** Props whose change means a new sandbox (Boat can't change them on a live one). */
const replacingProps = (props: SandboxProps) =>
  JSON.stringify({
    type: props.type ?? "default",
    env: plainEnv(props.env) ?? {},
    environment: props.environment,
    noEnv: props.noEnv ?? false,
    snapshots: props.snapshots ?? true,
    monitoring: props.monitoring ?? true,
    setupScript: props.setupScript,
    from: props.from,
    labels: props.labels ?? {},
  });

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      return {
        stables: ["sandboxId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (replacingProps(olds) !== replacingProps(news)) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (output === undefined) return undefined;
          const sandbox = yield* observeSandbox(output.sandboxId);
          if (sandbox === undefined) return undefined;
          const attrs = toAttributes(sandbox);
          return (yield* hasOwnershipLabels(id, sandbox.labels)) ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ sandboxId }) {
          const sandbox = yield* observeSandbox(sandboxId);
          return sandbox === undefined ? undefined : toAttributes(sandbox);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* boatName(id, news.name ?? output?.name, 120);
          const owner = yield* ownershipLabels(id);

          // Observe — `output` caches the id; the sandbox may be gone.
          let sandbox = output === undefined ? undefined : yield* observeSandbox(output.sandboxId);

          // Ensure
          if (sandbox === undefined) {
            yield* session.note(`Creating sandbox ${name}...`);
            const created = yield* boat.createSandbox({
              ...(news.type === undefined ? {} : { type: news.type }),
              ...(news.ttlSeconds === undefined ? {} : { ttlSeconds: news.ttlSeconds }),
              ...(news.env === undefined ? {} : { env: plainEnv(news.env) }),
              ...(news.environment === undefined ? {} : { environment: news.environment }),
              ...(news.noEnv === undefined ? {} : { noEnv: news.noEnv }),
              ...(news.snapshots === undefined ? {} : { snapshots: news.snapshots }),
              ...(news.monitoring === undefined ? {} : { monitoring: news.monitoring }),
              ...(news.setupScript === undefined ? {} : { setupScript: news.setupScript }),
              ...(news.from === undefined ? {} : { from: news.from }),
              labels: { ...news.labels, ...owner },
            });
            sandbox = created.sandbox;
          }

          // Sync — name, subdomain and auto-stop, against what Boat reports.
          const ttlChanged =
            news.ttlSeconds !== undefined && (sandbox.ttlSeconds ?? null) !== news.ttlSeconds;
          const subdomainChanged =
            news.subdomain !== undefined && sandbox.subdomain !== news.subdomain;
          if (sandbox.name !== name || ttlChanged || subdomainChanged) {
            const updated = yield* boat.updateSandbox({
              sandboxId: sandbox.id,
              ...(sandbox.name !== name ? { name } : {}),
              ...(ttlChanged ? { ttlSeconds: news.ttlSeconds } : {}),
              ...(subdomainChanged ? { subdomain: news.subdomain } : {}),
            });
            sandbox = updated.sandbox ?? sandbox;
          }

          return toAttributes(sandbox);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSandbox(output.sandboxId);
        }),
        // Declared sandboxes and the ones bindings create at run time both
        // carry `alchemy.stack`, so `nuke` finds both.
        list: Effect.fn(function* () {
          const all = yield* Stream.runCollect(boat.listSandboxes.items({ limit: 100 }));
          return Array.from(all)
            .filter(
              (sandbox) => sandbox.state !== "cancelled" && hasAnyAlchemyLabel(sandbox.labels),
            )
            .map(toAttributes);
        }),
      };
    }),
  );
