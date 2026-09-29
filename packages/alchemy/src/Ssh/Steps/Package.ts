import * as Effect from "effect/Effect";
import { execute, facts, StepFailed, type StepPolicy } from "../Recipe.ts";
import { makeAptStep } from "./Apt.ts";
import { makeDnfStep } from "./Dnf.ts";

export interface PackageInput {
  /** Exact package names as the host's package manager knows them. */
  packages: string | ReadonlyArray<string>;
  /** @default "present" */
  state?: "present" | "absent" | "latest";
  /** Refresh a stale apt index first. `dnf` refreshes its metadata itself. */
  update?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

/**
 * Packages through whichever package manager the host has (`apt` or `dnf`).
 * Use `apt` or `dnf` directly for manager-specific options.
 */
const pkg = (input: PackageInput) =>
  Effect.gen(function* () {
    const { pkgManager, distroId } = yield* facts;
    if (pkgManager === "apt") return yield* execute(makeAptStep(input));
    if (pkgManager === "dnf") return yield* execute(makeDnfStep(input));
    return yield* new StepFailed({
      message: `package: no supported package manager (apt or dnf) on ${distroId || "this host"}`,
      kind: "package",
      step: [input.packages].flat().join(" "),
    });
  });

export { pkg as package };
