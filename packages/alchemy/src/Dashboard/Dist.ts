import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { UserFacingError } from "../UserFacingError.ts";

/**
 * Where the prebuilt dashboard SPA lives: the `dist/` of the optional
 * `@alchemy.run/dashboard` peer dependency. Kept in its own leaf module
 * (FileSystem + Path only) so both the CLI server and the hosted-dashboard
 * factories can resolve it without pulling the HTTP server in.
 */

/**
 * The dashboard UI is an optional peer dependency; this is the one error a
 * `--ui` run, `alchemy dashboard`, or a hosted-dashboard deploy fails with
 * when it is not installed. Marked user-facing so the CLI prints the
 * install instructions as-is instead of a cause dump.
 */
export class DashboardNotInstalled extends Data.TaggedError(
  "DashboardNotInstalled",
)<{}> {
  readonly [UserFacingError] = true;
  override get message() {
    return [
      "The alchemy dashboard UI is not installed.",
      "",
      "It ships as a separate optional package so the core CLI stays lean:",
      "",
      "  bun add -D @alchemy.run/dashboard",
      "  # or: npm install --save-dev @alchemy.run/dashboard",
      "",
      "Then re-run this command.",
    ].join("\n");
  }
}

/**
 * Locate the prebuilt dashboard SPA (`@alchemy.run/dashboard/dist`).
 * `@alchemy.run/dashboard` is an optional peer dependency — returns
 * undefined when it isn't installed. Overridable via
 * `ALCHEMY_DASHBOARD_DIST` for development.
 */
export const resolveDistDir = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const override = yield* Effect.sync(() => process.env.ALCHEMY_DASHBOARD_DIST);
  if (override) {
    return (yield* fs.exists(override).pipe(Effect.orElseSucceed(() => false)))
      ? override
      : undefined;
  }
  const resolved = yield* Effect.try(() =>
    import.meta.resolve("@alchemy.run/dashboard/package.json"),
  ).pipe(Effect.option);
  if (resolved._tag === "Some") {
    const pkgDir = path.dirname(new URL(resolved.value).pathname);
    const dist = path.join(pkgDir, "dist");
    if (yield* fs.exists(dist).pipe(Effect.orElseSucceed(() => false))) {
      return dist;
    }
  }
  return undefined;
});

/**
 * Resolve the dashboard SPA directory or fail with
 * {@link DashboardNotInstalled}. Callers check this *before* doing any real
 * work so a `--ui` run fails fast rather than mid-deploy.
 */
export const requireDistDir = Effect.fn(function* () {
  const dist = yield* resolveDistDir();
  if (dist === undefined) {
    return yield* new DashboardNotInstalled();
  }
  return dist;
});
