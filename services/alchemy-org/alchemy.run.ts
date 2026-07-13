/**
 * The AlchemyOrg Stack — NOT deployed yet: `bun alchemy deploy` will
 * provision the repos' webhooks when we're ready (and, in later phases,
 * the Worker in src/worker.ts plus the DevBox containers backing the
 * Engineer's tools).
 *
 * The same program that defines the org provisions the surface it
 * manages: the exported repo consts (src/repos.ts) ARE the resources —
 * yielding them here provisions them, and the charters' deferred scoped
 * sources resolve to the same instances (memoized by FQN).
 */
import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { alchemyEffect, distilled } from "./src/repos.ts";

export default Alchemy.Stack(
  "AlchemyOrg",
  { providers: GitHub.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const alchemy = yield* alchemyEffect;
    const distilledRepo = yield* distilled;

    // Resource-first scoped sources: the SAME resources that provision
    // the repositories scope their event catalog — here the RESOLVED
    // (yielded) form; the flywheel charter passes the exported consts
    // (the DEFERRED form). Both name the same wire — the one
    // GitHub.frontDoor(ResolveGitHubIssue) consumes.
    const issueOpened = GitHub.IssueOpened(alchemy);
    const issueClosed = GitHub.IssueClosed(alchemy);
    const distilledMerged = GitHub.PullRequestMerged(distilledRepo);

    return {
      alchemy: alchemy.fullName,
      distilled: distilledRepo.fullName,
      // the scoped sources are pure data — surface their identities so
      // the deploy output shows what the org subscribes to
      sources: [issueOpened.name, issueClosed.name, distilledMerged.name],
    };
  }),
);
