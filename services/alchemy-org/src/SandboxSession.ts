import * as Alchemy from "alchemy";
import * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Command from "alchemy/Command";
import type * as Git from "alchemy/Git";
import type * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { CheckoutsSandbox } from "./services/CheckoutsSandbox.ts";
import { CheckoutsWorkspace } from "./services/CheckoutsWorkspace.ts";
import { SandboxCheckout } from "./services/SandboxCheckout.ts";
import { SessionRepoLive } from "./services/SessionRepo.ts";

/** Thread keys are `<session>::<thread>` — the SESSION owns the machine,
 *  so every thread of a session (and its terminal) shares one. */
const machineKey = (key: string) => key.split("::")[0]!;

/** The Worker env key the dev sandbox server's address is bound under. */
const SANDBOX_URL_KEY = "ORG_SANDBOX_URL";

/** PINNED like the Worker (1340) and the Website (1337): one address
 *  across restarts, no port roulette between the three processes. */
const SANDBOX_DEV_PORT = 1341;

/**
 * Deployed: each session's own AWS Lambda MicroVM (Firecracker) launched
 * from the shared image, driven cross-cloud from this Worker (the
 * HTTP/token binding impls mint an IAM user + assume-role for it).
 */
const SandboxMicrovm = AWS.AI.SandboxMicrovmSession({ machineKey }).pipe(
  Layer.provide(
    Layer.mergeAll(
      AWS.Lambda.RunMicrovmHttp,
      AWS.Lambda.GetMicrovmHttp,
      AWS.Lambda.CreateAuthTokenHttp,
      // session lifecycle → machine lifecycle: settle suspends the
      // session's VM, resume wakes it, remove terminates it (wired in
      // the driver)
      AWS.Lambda.SuspendMicrovmHttp,
      AWS.Lambda.ResumeMicrovmHttp,
      AWS.Lambda.TerminateMicrovmHttp,
    ),
  ),
);

/**
 * `alchemy dev`: THIS repository's working tree, served by
 * `scripts/sandbox-dev.ts` (a `Command.Dev` beside the local Worker)
 * and reached at a fixed address — no image build, no launch. Every
 * session gets its own linked worktree of this repository under
 * `.alchemy/worktrees/` (`CheckoutsWorkspace`), which `SandboxCheckout`
 * re-roots the session's tools and terminal into: sessions edit and
 * build in seconds, and the developer's own checkout stays theirs.
 */
const SandboxWorkspace = (url: Effect.Effect<string | undefined>) =>
  AI.SandboxHttp({ url, machineKey });

/** The machine plus git over it — ONE build per machine so the
 *  toolbox, the spill store, the checkout, and the terminal door all
 *  land on the same registry. The `AI.Sandbox` handed out is the
 *  CONVERGING one (`SandboxCheckout`): the session's tree lands on the
 *  machine the first time anything touches it, never at INIT. Git
 *  itself runs over the raw machine — it IS the converge. */
const machine = <R>(
  sandbox: Layer.Layer<AI.Sandbox, never, R>,
  checkouts: Layer.Layer<Git.Checkouts, never, AI.Sandbox>,
): Layer.Layer<
  AI.Sandbox | Git.Checkouts,
  never,
  R | GitHub.GetPullRequest
> => {
  const git = checkouts.pipe(Layer.provide(sandbox));
  const converging = SandboxCheckout.pipe(
    Layer.provide(Layer.mergeAll(sandbox, git, SessionRepoLive)),
  );
  return Layer.mergeAll(converging, git);
};

/**
 * Each session's own machine (`AI.Sandbox`) and git over it
 * (`Git.Checkouts`), resolved at CALL time from the session. WHICH
 * machine is decided ONCE, at layer build, from the world the code runs
 * in:
 *
 * - **plan** (the CLI evaluating the Worker): `AlchemyContext.dev`
 *   picks — a deploy binds the MicroVM operations onto the Worker; a
 *   dev run declares the `Sandbox` dev process and binds its address
 *   into the Worker env instead.
 * - **runtime** (inside the Worker): the bound address is present
 *   exactly when the plan ran under dev, so it is the selector — no
 *   flag to keep in sync with the plan-time decision.
 *
 * To go back to the Cloudflare Container attached to the session DO,
 * swap `SandboxMicrovm` for `Cloudflare.AI.SandboxContainerSession({
 * enableInternet: true })` (and mirror the swap in
 * services/DriverCloudflare.ts + alchemy.run.ts).
 */
export const SandboxSession = Layer.unwrap(
  Effect.gen(function* () {
    // the host's context (plan AND runtime) — read as an option so the
    // requirement does not leak past the Worker onto the stack program
    const runtime = Option.getOrUndefined(
      yield* Effect.serviceOption(Alchemy.RuntimeContext),
    );
    if (runtime === undefined) {
      return yield* Effect.die(
        "SandboxSession must build inside a host (a Worker): no RuntimeContext",
      );
    }
    const url = runtime.get<string>(SANDBOX_URL_KEY);
    const context = yield* Effect.serviceOption(Alchemy.AlchemyContext);

    if (Option.isSome(context)) {
      if (!context.value.dev) {
        return machine(SandboxMicrovm, CheckoutsSandbox);
      }
      // the host process — spawned into the dev sidecar (so it survives
      // this Worker's hot reloads) with cwd = this service directory
      const server = yield* Command.Dev("Sandbox", {
        command: "bun scripts/sandbox-dev.ts",
        env: { PORT: String(SANDBOX_DEV_PORT) },
      });
      yield* runtime.set(SANDBOX_URL_KEY, server.url);
      return machine(SandboxWorkspace(url), CheckoutsWorkspace);
    }

    return (yield* url) === undefined
      ? machine(SandboxMicrovm, CheckoutsSandbox)
      : machine(SandboxWorkspace(url), CheckoutsWorkspace);
  }),
);
