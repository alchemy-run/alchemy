import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Sandbox } from "../../AI/Sandbox.ts";
import {
  errorText,
  sandboxOverRpc,
  type SandboxRpcShape,
} from "../../AI/SandboxRpc.ts";
import { Thread } from "../../AI/Thread.ts";
import { CreateAuthToken } from "../Lambda/CreateAuthToken.ts";
import { GetMicrovm } from "../Lambda/GetMicrovm.ts";
import { MicrovmImage } from "../Lambda/MicrovmImage.ts";
import { connectMicrovm } from "../Lambda/MicrovmRpc.ts";
import { ResumeMicrovm } from "../Lambda/ResumeMicrovm.ts";
import { RunMicrovm } from "../Lambda/RunMicrovm.ts";
import { SuspendMicrovm } from "../Lambda/SuspendMicrovm.ts";
import { TerminateMicrovm } from "../Lambda/TerminateMicrovm.ts";
import type { Providers } from "../Providers.ts";

/**
 * The typed RPC surface the sandbox MicroVM guest serves — a 1:1
 * mirror of the {@link Sandbox} contract, so a connected MicroVM stub
 * satisfies the seam directly. Identical to the Cloudflare
 * `SandboxContainerShape`: the SAME guest physics on a different
 * machine — see {@link SandboxRpcShape}.
 */
export interface SandboxMicrovmShape extends SandboxRpcShape {}

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
  /**
   * Derive the MACHINE key from the session key. Sessions whose keys
   * map to the same machine key SHARE one MicroVM — e.g. the org's
   * `<session>::<thread>` convention gives every thread of a session
   * (and its terminals) the same machine by stripping the `::<thread>`
   * suffix. The default is the identity: one machine per session.
   */
  readonly machineKey?: (sessionKey: string) => string;
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
 *  minted uuids) don't collide in practice.
 *
 *  EXPORTED so out-of-session doors (an operator terminal reaching a
 *  session's machine from the Worker's HTTP surface) can derive the
 *  same clientToken and reattach to the same VM instead of launching
 *  a stranger. */
export const sessionToken = (key: string): string => {
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
 * - **reap** — three tiers: the idle policy suspends and then expires
 *   an ABANDONED session's VM on its own; a SETTLED session's VM is
 *   suspended immediately (the driver calls `lifecycle.suspend`); a
 *   REMOVED session's VM is terminated (`lifecycle.destroy`).
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
  | RunMicrovm
  | GetMicrovm
  | CreateAuthToken
  | SuspendMicrovm
  | ResumeMicrovm
  | TerminateMicrovm
  | Providers
> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      // resolve the bindings at layer build (Worker/Function init) —
      // this registers the image-scoped IAM grants on the host
      const runMicrovm = yield* RunMicrovm(SandboxMicrovmImage);
      const getMicrovm = yield* GetMicrovm(SandboxMicrovmImage);
      const createAuthToken = yield* CreateAuthToken(SandboxMicrovmImage);
      const suspendMicrovm = yield* SuspendMicrovm(SandboxMicrovmImage);
      const resumeMicrovm = yield* ResumeMicrovm(SandboxMicrovmImage);
      const terminateMicrovm = yield* TerminateMicrovm(SandboxMicrovmImage);
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

      const runRequest = {
        idlePolicy,
        ...(options?.maximumDurationInSeconds !== undefined
          ? { maximumDurationInSeconds: options.maximumDurationInSeconds }
          : {}),
      };

      /** Poll a machine to a verdict: `running` (with its endpoint),
       *  or `gone` — terminated/terminating/vanished. A SUSPENDED
       *  reattach is woken (the idle policy parked it; the session is
       *  back). PENDING/SUSPENDING keep polling. */
      const settle = (microvmId: string) =>
        Effect.gen(function* () {
          const observed = yield* getMicrovm({
            microvmIdentifier: microvmId,
          }).pipe(Effect.result);
          if (Result.isFailure(observed)) {
            return observed.failure._tag === "ResourceNotFoundException"
              ? ({ _tag: "gone" } as const)
              : yield* Effect.fail(observed.failure);
          }
          const m = observed.success;
          switch (m.state) {
            case "RUNNING":
              return { _tag: "running", endpoint: m.endpoint! } as const;
            case "TERMINATED":
            case "TERMINATING":
              return { _tag: "gone" } as const;
            case "SUSPENDED":
              yield* resumeMicrovm({ microvmIdentifier: microvmId }).pipe(
                Effect.catchTag(
                  ["ConflictException", "ValidationException"],
                  () => Effect.void,
                ),
              );
              return yield* Effect.fail(new Error(`microvm ${m.state}`));
            default:
              return yield* Effect.fail(new Error(`microvm ${m.state}`));
          }
        }).pipe(
          Effect.retry({
            while: (error) => error instanceof Error,
            schedule: Schedule.spaced("2 seconds"),
            times: 60,
          }),
        );

      /**
       * Resolve the session's machine: reattach to a live one, or
       * launch. The clientToken is a WALK, not a single value — the
       * base token plus a generation suffix. `RunMicrovm`'s
       * idempotency record outlives the machine it names: a token
       * whose VM was terminated (an image update recycling old
       * versions, idle expiry, a crash) is SPENT — AWS answers with
       * `ValidationException: clientToken was used with different
       * request parameters` once the image has moved on, or hands back
       * the dead machine itself. Either way the session must never be
       * pinned to that corpse (it was: every pre-redeploy session sat
       * on "starting the machine" forever). A spent generation is
       * skipped; the walk is deterministic, so a fresh isolate
       * re-derives the same live generation instead of launching a
       * stranger, and two isolates racing the same generation still
       * land on one VM.
       */
      const MAX_GENERATIONS = 64;
      const resolveMachine = (
        token: string,
        wait: boolean,
      ): Effect.Effect<{ microvmId: string; endpoint: string }, string> =>
        Effect.gen(function* () {
          for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
            const clientToken = gen === 0 ? token : `${token}-g${gen}`;
            const run = yield* runMicrovm({
              clientToken,
              ...runRequest,
            }).pipe(Effect.result);
            if (Result.isFailure(run)) {
              if (
                run.failure._tag === "ValidationException" &&
                /clientToken/i.test(run.failure.message ?? "")
              ) {
                yield* Effect.logDebug(
                  `[terminal-debug] ${clientToken}: spent (image moved on) — next generation`,
                );
                continue;
              }
              return yield* Effect.fail(errorText(run.failure));
            }
            const vm = run.success;
            if (!wait) {
              return { microvmId: vm.microvmId, endpoint: vm.endpoint! };
            }
            // wait until the VM serves before handing out the stub
            const verdict = yield* settle(vm.microvmId).pipe(
              Effect.mapError(errorText),
            );
            if (verdict._tag === "running") {
              return { microvmId: vm.microvmId, endpoint: verdict.endpoint };
            }
            yield* Effect.logDebug(
              `[terminal-debug] ${clientToken}: ${vm.microvmId} is gone — next generation`,
            );
          }
          return yield* Effect.fail(
            `no live machine for ${token} after ${MAX_GENERATIONS} generations`,
          );
        });

      const vmFor = (token: string) => {
        const existing = vms.get(token);
        if (existing !== undefined) return existing;
        const launched = Effect.cached(
          resolveMachine(token, true).pipe(Effect.orDie),
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
          yield* Effect.logDebug(
            `[terminal-debug] stubFor(${token}): launching/attaching VM`,
          );
          const vm = yield* vmFor(token);
          yield* Effect.logDebug(
            `[terminal-debug] stubFor(${token}): vm=${vm.microvmId} endpoint=${vm.endpoint} — minting token`,
          );
          const { authToken } = yield* createAuthToken({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: tokenMinutes,
            allowedPorts: [{ port }],
          }).pipe(Effect.orDie);
          yield* Effect.logDebug(
            `[terminal-debug] stubFor(${token}): token minted — connecting`,
          );
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

      /** Whether the session's cached machine is GONE — terminated or
       *  vanished (idle expiry, an image update recycling its VMs). A
       *  dead cached VM must not poison the session: the caches drop
       *  and the retry relaunches (RunMicrovm is clientToken-idempotent,
       *  so a live machine is reattached, never duplicated). */
      const isMachineGone = (token: string) =>
        Effect.gen(function* () {
          const launched = vms.get(token);
          if (launched === undefined) return false;
          const vm = yield* launched;
          const observed = yield* getMicrovm({
            microvmIdentifier: vm.microvmId,
          }).pipe(Effect.result);
          return Result.isSuccess(observed)
            ? observed.success.state === "TERMINATED" ||
                observed.success.state === "TERMINATING"
            : // not found (or unreadable): treat as gone — the relaunch
              // is idempotent, so a false positive costs one API call
              true;
        });

      // The session context carries Thread at call time (every driver
      // provides it); the contract's R stays clean — same cast the
      // container session layer makes for DurableObjectState.
      const withMachine = <A, E>(
        use: (machine: {
          readonly token: string;
          /** Whether the calling session's key IS the machine key —
           *  a `<session>::<thread>` key SHARES the session's machine
           *  and must never suspend/terminate it. */
          readonly owner: boolean;
        }) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const thread = yield* Thread;
          const machineKey =
            options?.machineKey === undefined
              ? thread.key
              : options.machineKey(thread.key);
          return yield* use({
            token: sessionToken(machineKey),
            owner: machineKey === thread.key,
          });
        }) as unknown as Effect.Effect<A, E>;

      const withToken = <A, E>(
        use: (token: string) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> => withMachine(({ token }) => use(token));

      const withBox = <A, E>(
        use: (stub: SandboxMicrovmShape) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        withToken((token) => {
          const attempt = Effect.gen(function* () {
            const stub = yield* stubFor(token);
            return yield* use(stub);
          });
          return attempt.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (!(yield* isMachineGone(token))) {
                  return yield* Effect.fail(error);
                }
                vms.delete(token);
                stubs.delete(token);
                return yield* attempt;
              }),
            ),
          );
        });

      return {
        // the contract over the connected stub — every call resolves the
        // calling session's machine (launch / reattach / relaunch-if-gone)
        ...sandboxOverRpc(withBox),
        lifecycle: {
          /**
           * Snapshot the session's machine on settle. Only the machine
           * OWNER acts (a `::thread` key shares the session's machine —
           * settling one thread must not suspend what its siblings are
           * using), and only a machine THIS isolate launched/attached
           * is suspended: an uncached machine (the isolate restarted
           * since the session's last activity) has already been idle
           * that long and its own idle policy owns it.
           */
          suspend: withMachine(({ token, owner }) =>
            Effect.gen(function* () {
              if (!owner) return;
              const launched = vms.get(token);
              if (launched === undefined) return;
              const vm = yield* launched;
              yield* suspendMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
                Effect.mapError(errorText),
              );
              // a suspend/resume cycle invalidates the connected stub
              stubs.delete(token);
            }),
          ),
          /**
           * Eagerly wake the machine on session resume. Cached-only,
           * like suspend: an unknown machine wakes lazily (or launches
           * fresh) on the session's next sandbox call anyway — the
           * eager wake is warmth, not correctness. A machine that is
           * not suspended (already running, mid-transition) is a
           * no-op; a machine that is GONE drops the caches so the
           * next call relaunches cleanly.
           */
          resume: withToken((token) =>
            Effect.gen(function* () {
              const launched = vms.get(token);
              if (launched === undefined) return;
              const vm = yield* launched;
              yield* resumeMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
                Effect.catchTag(
                  ["ConflictException", "ValidationException"],
                  () => Effect.void,
                ),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.sync(() => {
                    vms.delete(token);
                    stubs.delete(token);
                  }),
                ),
                Effect.mapError(errorText),
                Effect.asVoid,
              );
            }),
          ),
          /**
           * Terminate the session's machine on remove. WHETHER to
           * terminate is the caller's call, not this layer's: the
           * driver only invokes `destroy` for the LAST thread of the
           * machine group (`Sessions.remove`'s `machine` flag, decided
           * against the caller's directory) — deleting one `::thread`
           * of a session while siblings live never reaches here. The
           * CACHED id is authoritative when this isolate knows the
           * machine — a just-suspended VM is INVISIBLE to
           * `RunMicrovm`'s clientToken reattach (it only matches
           * running instances), so a blind reattach would mint a
           * fresh machine, terminate that, and leak the suspended
           * one. Only a cold isolate (no cache) falls back to the
           * reattach: it finds the live machine, or pays one
           * throwaway launch — the price of guaranteeing "removed
           * session ⇒ no machine".
           */
          destroy: withMachine(({ token }) =>
            Effect.gen(function* () {
              const launched = vms.get(token);
              const vm =
                launched !== undefined
                  ? yield* launched
                  : yield* resolveMachine(token, false);
              yield* terminateMicrovm({
                microvmIdentifier: vm.microvmId,
              }).pipe(Effect.mapError(errorText));
              vms.delete(token);
              stubs.delete(token);
            }),
          ),
        },
      };
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
