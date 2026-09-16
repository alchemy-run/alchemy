/**
 * The dev-mode session machine: this repository's WORKSPACES —
 * `.alchemy/workspaces/`, one linked worktree per workspace — served
 * as a sandbox over the guest RPC protocol from a plain Bun process on
 * the host. `alchemy dev` runs it as the `Sandbox` `Command.Dev` (see
 * src/sandbox/SandboxSession.ts) and points the local Worker's
 * sessions at it — no MicroVM image, no bake, no launch.
 *
 * THE ROOT IS THE WORKSPACES DIRECTORY, not the repository: sessions
 * can only ever address workspace trees — the developer's own checkout
 * is structurally out of reach (an engineer once ran git against it;
 * never again). The repository itself is touched only by the
 * workspace verbs (`makeWorkspaceHost`), which run in THIS process
 * behind three fixed RPC methods.
 *
 * ```sh
 * PORT=1341 bun scripts/sandbox-dev.ts
 * ```
 */
import { BunServices } from "@effect/platform-bun";
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as path from "node:path";
import {
  makeWorkspaceHost,
  WORKSPACES_DIR,
} from "../src/sandbox/WorkspaceHost.ts";

const repo = path.resolve(import.meta.dir, "../../..");

await Effect.runPromise(
  Effect.gen(function* () {
    const host = yield* makeWorkspaceHost(repo);
    return yield* AI.serveSandbox({
      root: path.join(repo, WORKSPACES_DIR),
      extend: { ...host },
    });
  }).pipe(Effect.provide(BunServices.layer)),
);
