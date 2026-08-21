import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  Sandbox,
  type SandboxEntry,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "../../AI/Sandbox.ts";
import { Thread } from "../../AI/Thread.ts";
import { CreateAuthToken } from "../Lambda/CreateAuthToken.ts";
import { GetMicrovm } from "../Lambda/GetMicrovm.ts";
import { MicrovmImage } from "../Lambda/MicrovmImage.ts";
import { connectMicrovm } from "../Lambda/MicrovmRpc.ts";
import { RunMicrovm } from "../Lambda/RunMicrovm.ts";
import type { Providers } from "../Providers.ts";

/**
 * The typed RPC surface the sandbox MicroVM guest serves — a 1:1
 * mirror of the {@link Sandbox} contract, so a connected MicroVM stub
 * satisfies the seam directly. Identical to the Cloudflare
 * `SandboxContainerShape`: the SAME guest physics on a different
 * machine.
 */
export interface SandboxMicrovmShape {
  readonly exec: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ) => Effect.Effect<SandboxExecResult, string>;
  readonly readFile: (path: string) => Effect.Effect<string, string>;
  readonly writeFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, string>;
  readonly deleteFile: (path: string) => Effect.Effect<void, string>;
  readonly mkdir: (path: string) => Effect.Effect<void, string>;
  readonly listFiles: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>;
  readonly exists: (path: string) => Effect.Effect<boolean, string>;
}

/**
 * The sandbox MicroVM image declaration — the typed handle an
 * orchestrator (Worker or Lambda) imports to bind the instance
 * operations. Only the class lives here (Platform Layer pattern): the
 * runtime implementation is the default export of
 * `SandboxMicrovmRuntime.ts`, which must be provided on the Stack so
 * the image is built (server-side, on AWS) and deployed:
 *
 * ```ts
 * // alchemy.run.ts
 * Alchemy.Stack("Org", config, program.pipe(
 *   Effect.provide(AWS.AI.SandboxMicrovmRuntime),
 * ));
 * ```
 */
export class SandboxMicrovmImage extends MicrovmImage<
  SandboxMicrovmImage,
  SandboxMicrovmShape
>()("SandboxMicrovm") {}

export interface SandboxMicrovmOptions {
  /**
   * The instance idle policy. The default suspends after 15 idle
   * minutes, keeps the snapshot resumable for 60, and auto-resumes on
   * the next request — so an abandoned session's machine reaps itself
   * without an explicit terminate.
   */
  readonly idlePolicy?: {
    readonly maxIdleDurationSeconds?: number;
    readonly suspendedDurationSeconds?: number;
    readonly autoResumeEnabled?: boolean;
  };
  /** The in-VM server port (must match the image). @default 8080 */
  readonly port?: number;
  /** Auth-token validity; re-minted before expiry. @default 60 minutes */
  readonly authTokenMinutes?: number;
  /** Hard cap on a MicroVM's lifetime, in seconds. */
  readonly maximumDurationInSeconds?: number;
}

const DEFAULT_IDLE_POLICY = {
  maxIdleDurationSeconds: 900,
  suspendedDurationSeconds: 3600,
  autoResumeEnabled: true,
};

/** FNV-1a over the session key — `clientToken` must be short and
 *  deterministic; the token makes `RunMicrovm` idempotent per session,
 *  so a fresh isolate reattaches to the session's live VM instead of
 *  launching a second one. Keyed on `Thread.key` alone (the session
 *  context carries no term), so two TERMS sharing a session key would
 *  share a machine — org key conventions (`main`, `owner/repo#7`,
 *  minted uuids) don't collide in practice. */
const sessionToken = (key: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `sbx-${(hash >>> 0).toString(16)}-${key.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40)}`;
};

/**
 * The PER-SESSION AWS Lambda MicroVM {@link Sandbox} — the cross-cloud
 * sibling of `Cloudflare.AI.SandboxContainerSession`: sessions stay
 * wherever the driver placed them (Durable Objects under
 * `DriverCloudflare`), and each session's MACHINE is a Firecracker
 * MicroVM launched from {@link SandboxMicrovmImage}. The layer builds
 * in the shared per-isolate graph; the VM binds at CALL time from the
 * session's own identity ({@link Thread}), memoized per session key:
 *
 * - **launch** — `RunMicrovm` with a deterministic `clientToken`
 *   derived from the session key, so re-entry (a new isolate, a
 *   restarted DO) reattaches to the session's running VM;
 * - **connect** — waits for `RUNNING`, mints an auth token
 *   (re-minted before expiry), and speaks the image's typed RPC
 *   ({@link SandboxMicrovmShape}) over the VM endpoint;
 * - **reap** — no explicit terminate: the idle policy suspends and
 *   then expires an abandoned session's VM on its own.
 *
 * The VM's disk is EPHEMERAL, exactly like the container sandbox:
 * work that must outlive the machine leaves through git (push), not
 * the local filesystem.
 *
 * Binding implementations are the caller's choice — pipe the
 * HTTP/token layers (they work from Lambda AND, via the minted
 * IAM-user + assume-role credentials, from a Cloudflare Worker):
 *
 * ```ts
 * // in the org's charter provide-list, replacing SandboxContainerSession:
 * Layer.provide(AWS.AI.SandboxMicrovmSession()),
 * Layer.provide(Layer.mergeAll(
 *   AWS.Lambda.RunMicrovmHttp,
 *   AWS.Lambda.GetMicrovmHttp,
 *   AWS.Lambda.CreateAuthTokenHttp,
 * )),
 * ```
 */
export const SandboxMicrovmSession = (
  options?: SandboxMicrovmOptions,
): Layer.Layer<
  Sandbox,
  never,
  // Providers are ambient in every stack program; the binding services
  // come from the HTTP/token impl layers the caller pipes underneath
  RunMicrovm | GetMicrovm | CreateAuthToken | Providers
> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      // resolve the bindings at layer build (Worker/Function init) —
      // this registers the image-scoped IAM grants on the host
      const runMicrovm = yield* RunMicrovm(SandboxMicrovmImage);
      const getMicrovm = yield* GetMicrovm(SandboxMicrovmImage);
      const createAuthToken = yield* CreateAuthToken(SandboxMicrovmImage);
      const httpClient = yield* HttpClient.HttpClient;

      const port = options?.port ?? 8080;
      const tokenMinutes = options?.authTokenMinutes ?? 60;
      const idlePolicy = { ...DEFAULT_IDLE_POLICY, ...options?.idlePolicy };

      /** session key → the launched VM (idempotent via clientToken). */
      const vms = new Map<
        string,
        Effect.Effect<{ microvmId: string; endpoint: string }>
      >();
      /** session key → connected stub + its token's expiry. */
      const stubs = new Map<
        string,
        { readonly stub: SandboxMicrovmShape; readonly expiresAt: number }
      >();

      const vmFor = (token: string) => {
        const existing = vms.get(token);
        if (existing !== undefined) return existing;
        const launched = Effect.cached(
          Effect.gen(function* () {
            const vm = yield* runMicrovm({
              clientToken: token,
              idlePolicy,
              ...(options?.maximumDurationInSeconds !== undefined
                ? { maximumDurationInSeconds: options.maximumDurationInSeconds }
                : {}),
            });
            // wait until the VM serves before handing out the stub
            yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
              Effect.flatMap((m) =>
                m.state === "RUNNING"
                  ? Effect.void
                  : Effect.fail(new Error(`microvm ${m.state}`)),
              ),
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 60,
              }),
            );
            return { microvmId: vm.microvmId, endpoint: vm.endpoint! };
          }).pipe(Effect.orDie),
        ).pipe(Effect.runSync);
        vms.set(token, launched);
        return launched;
      };

      const stubFor = (token: string): Effect.Effect<SandboxMicrovmShape> =>
        Effect.gen(function* () {
          const cached = stubs.get(token);
          if (cached !== undefined && cached.expiresAt > Date.now()) {
            return cached.stub;
          }
          const vm = yield* vmFor(token);
          const { authToken } = yield* createAuthToken({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: tokenMinutes,
            allowedPorts: [{ port }],
          }).pipe(Effect.orDie);
          const stub = yield* connectMicrovm(SandboxMicrovmImage, {
            endpoint: vm.endpoint,
            authToken,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          stubs.set(token, {
            stub,
            // re-mint a minute early so an in-flight call never
            // straddles the expiry
            expiresAt: Date.now() + (tokenMinutes - 1) * 60_000,
          });
          return stub;
        });

      // The session context carries Thread at call time (every driver
      // provides it); the contract's R stays clean — same cast the
      // container session layer makes for DurableObjectState.
      const withBox = <A, E>(
        use: (stub: SandboxMicrovmShape) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const thread = yield* Thread;
          const stub = yield* stubFor(sessionToken(thread.key));
          return yield* use(stub);
        }) as unknown as Effect.Effect<A, E>;

      return {
        exec: (command, args, execOptions) =>
          withBox((stub) => stub.exec(command, args, execOptions)),
        readFile: (path) => withBox((stub) => stub.readFile(path)),
        writeFile: (path, content) =>
          withBox((stub) => stub.writeFile(path, content)),
        deleteFile: (path) => withBox((stub) => stub.deleteFile(path)),
        mkdir: (path) => withBox((stub) => stub.mkdir(path)),
        listFiles: (path) => withBox((stub) => stub.listFiles(path)),
        exists: (path) => withBox((stub) => stub.exists(path)),
      };
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
