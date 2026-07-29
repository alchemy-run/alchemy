/**
 * The org, running on your machine — an Effectful {@link Local.Vite}
 * service hosting the factory as a detached local process: the
 * {@link OrgLocal} provide-list (KernelMemory, profile credentials,
 * REST polling, bun:sqlite, the local toolbox) under the shared HTTP
 * surface (Routes.ts), with the UI built by Vite and served from the
 * same address.
 *
 * Phases: the constructor runs at PLAN time too (to collect bindings),
 * and the org's machinery rides the constructor's LAYERS slot — built
 * with instance lifetime, so the background fibers (GitHub pollers,
 * kernel actor loops) live until the process is killed. GitHub
 * credentials resolve from the ALCHEMY PROFILE (`alchemy login`);
 * running additionally needs `ANTHROPIC_API_KEY` in the operator's
 * environment (the reconciler passes the shell env through).
 */
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { OrgLocal } from "./OrgLocal.ts";
import { orgRoutes } from "./Routes.ts";

export default class AlchemyOrg extends Local.Vite<AlchemyOrg>()(
  "AlchemyOrg",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output.
    // The UI (ui/, built by Local.Vite at deploy) is served from the
    // SAME server, so there is no second address to keep in sync.
    main: import.meta.url,
    memo: { include: ["src/**", "ui/**", "vite.config.ts"] },
  },
  Effect.gen(function* () {
    return {
      fetch: yield* HttpRouter.toHttpEffect(yield* orgRoutes),
    };
  }),
  OrgLocal,
) {}
