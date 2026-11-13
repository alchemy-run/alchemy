import * as SemVer from "effect/SemVer";
import * as SemVerRange from "effect/SemVerRange";

/** The JS runtime a build or dev child runs under. */
export type ChildRuntime = "node" | "bun";

const currentRuntime = (): ChildRuntime =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";

/**
 * Node CLI flags that strip TypeScript types, so a `.ts` runner entry works
 * when running from `src/` under plain Node. Mirrors alchemy's
 * `Util/Node.transformTypesFlags`.
 */
const transformTypesFlags = (): Array<string> =>
  SemVerRange.matches(
    SemVerRange.parseUnsafe(">=22.7.0 <26.0.0-0"),
    SemVer.parseUnsafe(process.versions.node),
    { includePrerelease: true },
  )
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];

/**
 * The executable and leading arguments that run `entry` under `runtime`:
 * this process's own executable when it already is that runtime, otherwise
 * `node` or `bun` from PATH.
 * @param runtime @default this process's runtime
 */
export const childCommand = (
  runtime: ChildRuntime | undefined,
  entry: string,
): { readonly executable: string; readonly args: Array<string> } => {
  const current = currentRuntime();
  const target = runtime ?? current;
  const executable = target === current ? process.execPath : target;
  if (target === "bun") return { executable, args: ["run", entry] };
  // The flags fit this process's Node; a Node from PATH strips types natively.
  const flags = entry.endsWith(".ts") && target === current ? transformTypesFlags() : [];
  return { executable, args: [...flags, entry] };
};
