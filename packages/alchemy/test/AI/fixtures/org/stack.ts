/**
 * The deployment sketch: the same Alchemy program that defines the agents
 * provisions the infrastructure they run on and the surfaces they manage.
 *
 * What deploys today: the two GitHub repositories (and, once wired, their
 * webhook event sources). What deploys in later phases: the ring Durable
 * Objects hosting Flywheel/Helpdesk/Autoresearch, the Fix Workflow, the
 * work queue, and the DevBox containers — each ring's charter compiling to
 * routes from the webhook ingestion to the ring's stimulus handler.
 */
import * as Effect from "effect/Effect";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import { localState } from "@/State/LocalState.ts";
import { alchemyEffect, distilled } from "./repos.ts";

export const OrgStack = Alchemy.Stack(
  "AlchemyOrg",
  { providers: GitHub.providers(), state: localState() },
  Effect.gen(function* () {
    const alchemy = yield* GitHub.Repository("alchemy-effect", {
      owner: alchemyEffect.owner,
      name: alchemyEffect.repository,
      description: "Infrastructure-as-Effects",
      hasIssues: true,
      deleteBranchOnMerge: true,
    });

    const distilledRepo = yield* GitHub.Repository("distilled", {
      owner: distilled.owner,
      name: distilled.repository,
      description: "Typed cloud SDKs, distilled from OpenAPI",
      hasIssues: true,
      deleteBranchOnMerge: true,
    });

    // TODO(phase 3+): provision the org runtime alongside the surfaces —
    //   - Ring DO namespace hosting Flywheel / Helpdesk / Autoresearch
    //   - Fix Workflow (iteration-scale durability) + `each` work queue
    //   - DevBox containers backing Bash/Grep/ReadFile/EditFile layers
    //   - webhook registrations routing GitHub/Discord events to rings

    return {
      alchemy: alchemy.fullName,
      distilled: distilledRepo.fullName,
    };
  }),
);
