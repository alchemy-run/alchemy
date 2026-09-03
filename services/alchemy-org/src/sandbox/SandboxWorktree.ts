import * as AI from "alchemy/AI";
import type * as Effect from "effect/Effect";

/** Thread keys are `<session>::<thread>` — the SESSION owns the machine,
 *  so every thread of a session (and its terminal) shares one. */
export const machineKey = (key: string) => key.split("::")[0]!;

/** The Worker env key the dev sandbox server's address is bound under. */
export const SANDBOX_URL_KEY = "ORG_SANDBOX_URL";

/** PINNED like the Worker (1340) and the Website (1337): one address
 *  across restarts, no port roulette between the three processes. */
export const SANDBOX_DEV_PORT = 1341;

/**
 * `alchemy dev`: THIS repository's working tree, served by
 * `scripts/sandbox-dev.ts` (a `Command.Dev` beside the local Worker)
 * and reached at a fixed address — no image build, no launch. Every
 * session gets its own linked WORKTREE of this repository under
 * `.alchemy/worktrees/` (`CheckoutsWorktree`), which `SandboxCheckout`
 * re-roots the session's tools and terminal into: sessions edit and
 * build in seconds, and the developer's own checkout stays theirs.
 *
 * The third machine beside {@link SandboxMicrovm} (deployed, AWS) and
 * `SandboxContainer` (the Cloudflare Container image).
 */
export const SandboxWorktree = (url: Effect.Effect<string | undefined>) =>
  AI.SandboxHttp({ url, machineKey });
