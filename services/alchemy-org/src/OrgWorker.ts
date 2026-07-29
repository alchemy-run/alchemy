/**
 * The org over CLOUDFLARE physics — the deployable provide-list, the
 * same shape as OrgLocal.ts with every seam answered by a Cloudflare
 * primitive:
 *
 * - kernel     → KernelCloudflare (one Durable Object per run, alarm
 *                recovery, the run-socket live view)
 * - GitHub     → the `*Http` bindings (a PersonalAccessToken bound as
 *                a Worker secret)
 * - events     → a real repository webhook (push delivery, verified)
 * - ledger     → D1 (every Worker instance agrees in the database)
 * - coding     → the SANDBOX container (services/Sandbox.ts): the
 *                local toolbox verbatim, on a machine with git and
 *                the repository checkouts, one RPC hop away
 * - approvals  → the same Ledger-backed record as local
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Layer from "effect/Layer";
import { ApprovalsLedger } from "./services/Approvals.ts";
import { D1Ledger } from "./services/LedgerD1.ts";
import { DoctrineSkills, Org } from "./Org.ts";
import { CodingWorker } from "./skills/Coding.ts";
import { QualityAssuranceWorker } from "./skills/QualityAssurance.ts";
import { EventsWorker } from "./services/Events.ts";
import { GitHubWorker } from "./services/GitHubBindings.ts";
import { KernelWorker, OrgChats } from "./services/Kernel.ts";
import { OpenPullRequestSandbox } from "./tools/SandboxToolbox.ts";
import { ApproveRecorded } from "./tools/index.ts";

export const OrgWorker = Org.pipe(
  Layer.provide([
    // the coding physics: the doctrine tree rides with the teaching
    CodingWorker.pipe(Layer.provideMerge(DoctrineSkills)),
    QualityAssuranceWorker,
    OpenPullRequestSandbox,
    // autonomous by default on the Worker; the supervised dial can
    // become a deploy-time Config when the console moves up here
    ApproveRecorded,
  ]),
  Layer.provideMerge(KernelWorker),
  Layer.provide(EventsWorker),
  Layer.provideMerge(ApprovalsLedger),
  Layer.provideMerge(
    D1Ledger.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)),
  ),
  // the chat projection (same const the kernel bundle observes into)
  Layer.provideMerge(OrgChats),
  Layer.provideMerge(GitHubWorker),
  Layer.orDie,
);
