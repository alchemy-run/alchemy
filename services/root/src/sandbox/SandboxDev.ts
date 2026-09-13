import * as AI from "alchemy/AI";
import type * as Effect from "effect/Effect";
import { machineKey } from "./Keys.ts";

/** The Worker env key the dev sandbox server's address is bound under. */
export const SANDBOX_URL_KEY = "ORG_SANDBOX_URL";

/** PINNED like the Worker (1340) and the Website (1337): one address
 *  across restarts, no port roulette between the three processes. */
export const SANDBOX_DEV_PORT = 1341;

/**
 * `alchemy dev`: this repository's WORKSPACES (`.alchemy/workspaces/`,
 * one linked worktree per workspace), served by `scripts/sandbox-dev.ts`
 * (a `Command.Dev` beside the local Worker) and reached at a fixed
 * address — no image build, no launch. The served root IS the
 * workspaces directory: sessions can address workspace trees and
 * NOTHING else — the developer's own checkout is structurally out of
 * reach. `WorkspaceRouter` maps each session's view onto the trees;
 * the machine key only scopes PTY ids on the one shared host process.
 *
 * The third machine beside `SandboxMicrovm` (deployed, AWS) and
 * `SandboxContainer` (the Cloudflare Container image).
 */
export const SandboxDev = (url: Effect.Effect<string | undefined>) =>
  AI.SandboxHttp({ url, machineKey });
