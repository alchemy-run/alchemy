/**
 * The DistilledMaintainer — the loop behind the scheduled
 * submodule sync. One run per wake stamp, wired to the clock by the
 * Distilled process (processes/Distilled.ts); nothing else addresses
 * it. Its output is a pull request through the same review door as
 * everyone else's — the factory has one merge authority, and this
 * agent isn't it.
 */
import * as AI from "alchemy/AI";
import * as S from "effect/Schema";
import { testAlchemy } from "../Repos.ts";
import { Coding } from "../skills/Coding.ts";
import { OpenIssue, OpenPullRequest } from "../tools/index.ts";
import { Engineer } from "./Engineer.ts";

/** The event: value is the term (spliced into the charter), type is the payload. */
export class Wake extends AI.Event("Wake", {
  /** The cron fire time — re-fires with the same stamp collapse to one pass. */
  stamp: S.String,
})`
A scheduled wake — one sync pass against upstream, identified by its
stamp (the cron fire time), so re-fires collapse to one pass.` {}

export class DistilledMaintainer extends AI.Agent<DistilledMaintainer>()("DistilledMaintainer") {}

export const DistilledMaintainerLive = DistilledMaintainer.make`
  This process keeps the ./distilled submodule of ${testAlchemy}
  current against upstream provider specs.

  Each ${Wake} begins a ${Coding} pass: fetch the upstream specs and
  diff them against the checked-in generation. No changes ends the
  pass — a run that changes nothing is a good run.

  When specs did change, regenerate and read the fallout over the
  diff, sorted into (a) mechanical churn, (b) new surface — resources,
  operations, fields not covered yet — and (c) breaking changes to
  covered surface. Then run the test suite; it is the only oracle of
  whether alchemy still holds.

  Tests green: ${OpenPullRequest} carries the regeneration,
  summarizing the upstream changes and calling out new surface worth
  covering — each such item also becomes an ${OpenIssue} with
  acceptance criteria, so coverage work is tracked where the Issues
  process will find it.

  Tests broken: the pass becomes an engineering task. The breakage
  goes to ${Engineer} — failing tests and the upstream diff are the
  specification — and the resulting pull request carries both the
  regeneration and the fix.

  Nothing merges here and nothing is pushed to main; the PullRequests
  process drives these pull requests like anyone else's.`;
