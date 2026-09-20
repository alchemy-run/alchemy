import type { Scenario } from "../scenario.ts";

/**
 * ROUTING ACCURACY — a batch of tasks with obvious ground-truth
 * areas, one per rubric plus a few extra shapes and one deliberately
 * ownerless task where `untagged` (inbox for a human) IS the right
 * answer. Scripted rounds just complete everything; the scenario's
 * whole point is the router's tag Choice (Router.ts over Tags.ts).
 */
const done = (summary: string) =>
  [
    {
      member: "engineer" as const,
      reply: `Done.\nDISPOSITION: complete — ${summary}`,
    },
    { member: "reviewer" as const, reply: "LGTM.", expect: "approved" as const },
  ] as const;

export const routing: Scenario = {
  name: "routing",
  description:
    "Router tag accuracy over obvious ground-truth areas (one per rubric + edges)",
  arrivals: [
    {
      afterMs: 0,
      title: "fix(do): alarms drop on Durable Object eviction",
      body:
        "When a Durable Object is evicted, its alarm is not re-registered on " +
        "wake — scheduled work silently stops. Re-register in the constructor " +
        "and add a live test on the Cloudflare Workers runtime.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("alarm re-registration on wake"),
    },
    {
      afterMs: 1,
      title: "fix(fly): blue/green deploy leaves the old machine running",
      body:
        "After a green cutover the blue Fly machine keeps running and billing. " +
        "The machine lifecycle should stop it once health checks pass.",
      tags: ["fly"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("blue machine stopped after cutover"),
    },
    {
      afterMs: 2,
      title: "fix(s3): bucket policy sync drops statements on adoption",
      body:
        "Adopting an existing S3 bucket with a foreign policy loses statements " +
        "on reconcile — the sync diffs against olds instead of observed state.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("policy sync diffs observed state"),
    },
    {
      afterMs: 3,
      title:
        "patch(cloudflare): type the 1012 not-onboarded error on Magic Transit",
      body:
        "createMagicTransitSite surfaces code 1012 as UnknownCloudflareError. " +
        "Add the JSON Patch to the Smithy model under patches/magic-transit/ " +
        "and regenerate the service so the tag is typed.",
      tags: ["distilled"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("MagicTransitNotOnboarded typed via patch"),
    },
    {
      afterMs: 4,
      title: "fix(forge): whole-tree API drops symlink entries",
      body:
        "The forge's tree endpoint omits symlinks, so the code browser renders " +
        "broken directories for repos that vendor via links.",
      tags: ["forge"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("symlinks carried through the tree API"),
    },
    {
      afterMs: 5,
      title: "fix(desks): digest delivered twice per claim",
      body:
        "The desk loop delivers the identity digest on every claim without " +
        "deduping by tip — the same reflection lands twice in one pump.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("digest deduped by tip"),
    },
    {
      afterMs: 6,
      title: "feat(queues): dead-letter queue support on Cloudflare Queues",
      body:
        "Expose max_retries and dead_letter_queue on the Queue resource and " +
        "wire the consumer binding so poisoned messages land in the DLQ.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("DLQ props on the Queue resource"),
    },
    {
      afterMs: 7,
      title: "feat(lambda): SQS event source mapping resource",
      body:
        "Add the Lambda event source mapping for SQS queues with batch size " +
        "and partial-batch-failure reporting, IAM policy included.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("SQS event source mapping"),
    },
    {
      afterMs: 8,
      title: "chore: tidy up the docs",
      body: "Things feel scattered lately. Someone should make a pass.",
      expect: { tag: "untagged", disposition: "complete", maxRounds: 1 },
      rounds: done("a docs pass"),
    },
  ],
  interactions: [
    "Watch the inbox: the ownerless docs chore should LAND there — routing it is your call.",
    "A wrong tag pill on any card is a router miss; retag it and the move is recorded as a human intervention.",
  ],
};
