/**
 * The deployment sketch: the same Alchemy program that defines the agents
 * provisions the infrastructure they run on and the surface they manage.
 *
 * What deploys today: the contrived `test-alchemy` sandbox repository
 * (and, once wired, its webhook event source). What deploys in later
 * phases: the Ring Durable Object hosting ResolveGitHubIssue, the work
 * queue, and the DevBox containers — the charter compiling to routes from
 * the webhook ingestion to the ring's stimulus handler.
 */
import * as Effect from "effect/Effect";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import { localState } from "@/State/LocalState.ts";
import { testAlchemy } from "./repos.ts";

export const OrgStack = Alchemy.Stack(
  "AlchemyOrg",
  { providers: GitHub.providers(), state: localState() },
  Effect.gen(function* () {
    // The exported const IS the resource: yielding it here provisions
    // the sandbox, and it is the same instance every other yield of
    // `testAlchemy` resolves (resources are memoized by FQN).
    const repo = yield* testAlchemy;

    // Resource-first scoped sources (canon §2a ruling 6): the SAME
    // resource that provisions the repository scopes its event catalog —
    // here the RESOLVED (yielded) form, whose deterministic name derives
    // from the resource's FQN (stable logical identity — unchanged by a
    // repository rename) and whose provisioning props come from its
    // identity props. The charter in processes.ts passes the exported
    // const itself (the DEFERRED form — module scope, before any deploy);
    // both forms name the same wire — the one the worker's hand-wired
    // `GitHub.consumeRepositoryEvents` delivery consumes.
    const issueOpened = GitHub.IssueOpened(repo);
    const issueClosed = GitHub.IssueClosed(repo);

    // TODO(phase 3+): provision the org runtime alongside the surface —
    //   - Ring DO namespace hosting ResolveGitHubIssue
    //   - work queue + DevBox containers backing Bash/Grep/ReadFile/
    //     EditFile layers
    //   - webhook registrations routing GitHub events to the ring

    return {
      repository: repo.fullName,
      // the scoped sources are pure data — surface their identities so
      // the deploy output shows what the org subscribes to
      sources: [issueOpened.name, issueClosed.name],
    };
  }),
);
