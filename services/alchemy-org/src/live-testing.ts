/**
 * The live-testing doctrine — the factory's verification discipline
 * plus the speed doctrine, as a PROSE-ONLY skill: the runner is just a
 * shell command the agent's generic ${Coding} toolbox runs; what makes
 * a fleet safe is the DISCIPLINE, and discipline is prose.
 */
import * as AI from "alchemy/AI";

export class LiveTesting extends AI.Skill<LiveTesting>()("LiveTesting") {}

/** The teaching — prose-only: no tool splices, nothing to provide. */
export const LiveTestingLive = LiveTesting.make`
  Testing resources against the real cloud. The one entry point is

      bun run test {suite} --profile testing

  run from the repo root with the bash tool's timeout set (300s is the
  wall for a suite; a suite needing more is a bug). Suite paths are
  relative to packages/alchemy (test/Cloudflare/{Service}/…); a bare
  word is a file-name substring filter; -t "{regex}" filters test
  names (escape metacharacters to filter literally).

  Every test follows one shape: deploy, verify OUT-OF-BAND by querying
  the API directly through distilled, mutate, verify again, destroy,
  and prove the destroy by watching the resource disappear with a
  typed wait-until-gone. A test never trusts the deploy's own report.

  Determinism: never Date.now() in a physical name — omit the name
  (the engine derives one) or use a constant unique to the test. Poll
  with Effect.repeat and a bounded schedule (times ≤ 8-10, backoff
  under ~60s), never while-loops over wall clock. Fixtures (CSRs,
  PEMs, JWKS) are generated once and checked in, never at test time.

  Speed doctrine: hitting the timeout wall IS the failure — read the
  partial output (the runner prints currently-running tests when
  nothing finishes for 10s; that list is where a hang lives), find the
  unbounded retry or infinite pagination, fix the cause; never just
  re-run hoping. Never poll for provisioning slower than ~90s —
  skipIf-gate behind an env var with the exact typed error recorded,
  and keep an ungated probe test that asserts the typed tag so the
  gate stays honest. Three-iteration budget: a suite not green after
  ~3 fix iterations whose blocker is platform behavior gets
  implemented fully, gated, verified skip-clean, and reported
  honestly.`;
