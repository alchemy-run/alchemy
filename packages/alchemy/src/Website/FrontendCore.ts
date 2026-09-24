import * as Effect from "effect/Effect";
import { FrameworkServerError } from "./Server.ts";

const FRONTEND_CORE_SPECIFIER = "@alchemy.run/frontend-frameworks/core";

/**
 * Loads `@alchemy.run/frontend-frameworks/core` when a website is built or
 * served. The package is an optional peer dependency, so provider entrypoints
 * that re-export their `Website` namespace (e.g. `alchemy/Prisma`) must not
 * import it statically — that would break every consumer that never deploys a
 * website and so never installed it.
 *
 * A missing install is a setup mistake, not a recoverable failure, so it is a
 * defect (as the static import's load-time crash was) and leaves callers'
 * error channels unchanged.
 */
export const importFrontendCore = Effect.tryPromise({
  try: () => import("@alchemy.run/frontend-frameworks/core"),
  catch: (cause) =>
    new FrameworkServerError({
      framework: FRONTEND_CORE_SPECIFIER,
      message:
        `Failed to import "${FRONTEND_CORE_SPECIFIER}". ` +
        "Install @alchemy.run/frontend-frameworks in your project to deploy a website.",
      cause,
    }),
}).pipe(Effect.orDie);
