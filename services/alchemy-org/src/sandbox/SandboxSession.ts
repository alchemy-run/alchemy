import * as Alchemy from "alchemy";
import type * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Command from "alchemy/Command";
import type * as Git from "alchemy/Git";
import type * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { machineKey } from "../thread/Terms.ts";
import { CheckoutsSandbox } from "./CheckoutsSandbox.ts";
import { CheckoutsWorkspace } from "./CheckoutsWorkspace.ts";
import { WorkspaceRouter } from "./WorkspaceRouter.ts";
import {
  SANDBOX_DEV_PORT,
  SANDBOX_URL_KEY,
  SandboxDev,
} from "./SandboxDev.ts";
import { SessionRepoLive } from "../github/SessionRepo.ts";

/**
 * Deployed: one AWS Lambda MicroVM (Firecracker) PER WORKSPACE (and per
 * standalone coder session), launched from the shared image
 * (`SandboxMicrovm.ts`), driven cross-cloud from this Worker (the
 * HTTP/token binding impls mint an IAM user + assume-role for it).
 * `machineKey` (Terms.ts) is what makes a workspace a machine: every
 * session key inside `t-x::ws-pr-7` addresses that one VM; a thread's
 * agents themselves own NO machine — their calls are routed per
 * workspace by `WorkspaceRouter`.
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

/** The machines plus git over them — ONE build per placement so the
 *  toolbox, the spill store, the workspaces, and the terminal door all
 *  land on the same registry. The `AI.Sandbox` handed out is the
 *  ROUTER (`WorkspaceRouter`): every call resolves WHICH workspace it
 *  addresses (an explicit `@name/…`, the session's default, a
 *  standalone session's implicit tree) and lands on that workspace's
 *  machine — there is no machine root to fall back to. Git itself runs
 *  over the raw machines — it IS the converge. */
const machine = <R>(
  sandbox: Layer.Layer<AI.Sandbox, never, R>,
  checkouts: Layer.Layer<Git.Checkouts, never, AI.Sandbox>,
): Layer.Layer<
  AI.Sandbox | Git.Checkouts,
  never,
  R | GitHub.GetPullRequest
> => {
  const git = checkouts.pipe(Layer.provide(sandbox));
  const routed = WorkspaceRouter.pipe(
    Layer.provide(Layer.mergeAll(sandbox, git, SessionRepoLive)),
  );
  return Layer.mergeAll(routed, git);
};

/**
 * Each session's view of its workspaces (`AI.Sandbox`, the router) and
 * git over the machines (`Git.Checkouts`), resolved at CALL time from
 * the session. WHICH physics is decided ONCE, at layer build, from the
 * world the code runs in:
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
 * platform/DriverCloudflare.ts + alchemy.run.ts).
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
      return machine(SandboxDev(url), CheckoutsWorkspace(url));
    }

    return (yield* url) === undefined
      ? machine(SandboxMicrovm, CheckoutsSandbox)
      : machine(SandboxDev(url), CheckoutsWorkspace(url));
  }),
);
