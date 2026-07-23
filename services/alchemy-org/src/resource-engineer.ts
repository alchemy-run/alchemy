/**
 * The ResourceEngineer — the factory's per-service laborer: one run
 * owns ONE distilled service and drives its resources and live tests
 * to green, patching the SDK for every unmatched error along the way
 * (the flywheel from the resource-factory blog post).
 *
 * This is AGENTS.md operationalized: the doctrines it used to carry
 * as prose sections are SKILLS here (${Coding} the keyboard,
 * ${TypedErrors} the patch-regenerate loop, ${Reconciling} the
 * lifecycle shape, ${LiveTesting} the verification discipline), and
 * the "structured result schema" every wave task demanded is the
 * run's TYPED EXIT: the run cannot end without filing a
 * {@link ServiceReport} — code observes the filing; a success claim
 * that never filed one is just another tick.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import { Coding } from "./coding.ts";
import { LiveTesting } from "./live-testing.ts";
import { Reconciling } from "./reconciling.ts";
import { TypedErrors } from "./typed-errors.ts";

export class ResourceEngineer extends AI.Agent<ResourceEngineer>()(
  "ResourceEngineer",
) {}

/**
 * The structured result the coordinator banks — AGENTS.md's wave
 * contract, now the run's exit value instead of a prompt convention.
 */
export interface ServiceReport {
  /** The distilled service this run owned. */
  readonly service: string;
  /** Resources implemented or finished (assess-first: includes prior work). */
  readonly resources: ReadonlyArray<string>;
  /** Whether the service's suites are green (skip-gated tests count). */
  readonly testsPassed: boolean;
  /** The exact command that proves it. */
  readonly testCommand: string;
  /** Patches written, each with the observed error that forced it. */
  readonly patches: ReadonlyArray<{
    readonly operation: string;
    readonly reason: string;
  }>;
  /** skipIf-gated tests with the exact typed error that gates them. */
  readonly skippedTests: ReadonlyArray<{
    readonly test: string;
    readonly error: string;
  }>;
  /** Anything the coordinator should know (entitlements, API drift). */
  readonly notes: string;
}

const reportParams = {
  service: AI.Parameter("service", S.String)`
    The distilled service this run owned.`,
  resources: AI.Parameter("resources", S.Array(S.String))`
    Every resource now implemented for the service, including prior
    work you finished rather than rewrote.`,
  testsPassed: AI.Parameter("testsPassed", S.Boolean)`
    True only when the service's suites ran green (skip-gated tests
    count as green when a skip-clean run is verified).`,
  testCommand: AI.Parameter("testCommand", S.String)`
    The exact runTests invocation that proves the verdict.`,
  patches: AI.Parameter(
    "patches",
    S.Array(S.Struct({ operation: S.String, reason: S.String })),
  )`
    Every patch written, with the observed error that forced it.`,
  skippedTests: AI.Parameter(
    "skippedTests",
    S.Array(S.Struct({ test: S.String, error: S.String })),
  )`
    Every skipIf-gated test with the exact typed error that gates it.`,
  notes: AI.Parameter("notes", S.String)`
    Entitlement limits hit, API drift observed, out-of-scope surface —
    what the next wave should know.`,
} as const;

/**
 * The kernel-default implementation. Budget: a service is a day of
 * work at most — 150 samplings without a report is a REFUSAL, not a
 * longer leash.
 */
export const ResourceEngineerLive = ResourceEngineer.make(
  Effect.gen(function* () {
    const filed = yield* Ref.make<ServiceReport | undefined>(undefined);

    const fileReport = yield* AI.Tool("file_report")`
      File the service report and end this run. Only file when the
      test verdict is real: ${reportParams.testsPassed} must be backed
      by the ${reportParams.testCommand} run you actually made, with
      ${reportParams.service}, ${reportParams.resources},
      ${reportParams.patches}, ${reportParams.skippedTests}, and
      ${reportParams.notes} complete — the coordinator banks this
      verbatim.`((report) =>
      Ref.set(filed, report as ServiceReport).pipe(
        Effect.as("report filed — the run concludes"),
      ),
    );

    return Effect.gen(function* () {
      // ACHIEVE: the report is the artifact; filing it ends the run
      const report = yield* Ref.get(filed);
      if (report !== undefined) return report;

      const { key } = yield* AI.Thread;
      const { count } = yield* AI.Tick;
      if (count >= 150) {
        return yield* Effect.fail(
          new AI.Refused({
            loop: `ResourceEngineer(${key})`,
            reason: "150 samplings without filing a service report",
            observed: count,
          }),
        );
      }

      return yield* AI.prose`
        You own ONE distilled service for this run — the service named
        in your task — and nothing else: only you touch its patches
        directory and regenerate its module, so never touch another
        service's.

        ASSESS FIRST: partial work may exist from an interrupted run.
        List the service's resource and test directories, read what is
        there, check registration — FINISH partial work rather than
        rewrite it.

        ${Coding} is the keyboard. ${Reconciling} is the shape of every
        provider you write. ${LiveTesting} is how you prove it against
        the real cloud. ${TypedErrors} is the ONE response to an
        unmatched error — patch and regenerate; never a catch in
        alchemy, never a loosened type.

        Registration discipline: Providers.ts and the provider barrel
        index.ts are shared files — single minimal insertions only,
        re-read and retry on conflict, never rewrite wholesale, and
        keep provider layers inside the nested Layer.mergeAll groups.
        Never run tsc or a build in any form — the coordinator owns
        type-checking at wave boundaries; the test runner resolves
        sources directly.

        Done is a filed report, nothing else: when the service's suites
        are green (or honestly skip-gated with their typed errors),
        ${fileReport}. A blocker that survives three fix iterations is
        gated and REPORTED, never burned against.`;
    });
  }),
);
