import type { Scenario } from "../scenario.ts";

/**
 * SCHEDULER AFFINITY — six tasks interleaved cloudflare/aws in
 * arrival order. FIFO would alternate areas every claim; the
 * scheduler's wide Choice is told same-tag adjacency beats FIFO, so
 * after the first pick each next pick should stay in the same area
 * until it runs dry. Scored per scheduler ask: when a ready candidate
 * shares a tag with the desk's recent work, picking one is
 * affinity-optimal.
 */
const done = (summary: string) =>
  [
    {
      member: "engineer" as const,
      reply: `Done.\nDISPOSITION: complete — ${summary}`,
    },
    { member: "reviewer" as const, reply: "LGTM.", expect: "approved" as const },
  ] as const;

export const affinity: Scenario = {
  name: "affinity",
  description:
    "Interleaved cloudflare/aws arrivals — same-tag adjacency should beat FIFO",
  affinity: true,
  arrivals: [
    {
      afterMs: 0,
      title: "fix(r2): bucket CORS rules drift on adopt",
      body:
        "Adopting an R2 bucket rewrites CORS from olds instead of observed " +
        "rules — the diff must read the cloud.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("CORS diff reads observed rules"),
    },
    {
      afterMs: 1,
      title: "fix(dynamodb): GSI delta application recreates indexes",
      body:
        "Updating a table with an unchanged GSI still deletes and recreates " +
        "it — the per-aspect diff mis-compares key schemas.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("GSI diff keyed on schema equality"),
    },
    {
      afterMs: 2,
      title: "fix(kv): TTLs under a minute are rounded to zero",
      body:
        "KV puts with expirationTtl < 60 silently drop the TTL — clamp to the " +
        "platform minimum and surface the clamp.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("TTL clamped to the platform minimum"),
    },
    {
      afterMs: 3,
      title: "fix(sqs): queue attribute sync fights eventual consistency",
      body:
        "getQueueAttributes right after createQueue reads stale state and the " +
        "sync re-applies attributes every deploy — bound a retry on observe.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("bounded retry on the observe read"),
    },
    {
      afterMs: 4,
      title: "fix(d1): remote migrations fail on uppercase BEGIN",
      body:
        "The remote D1 parser only accepts LF-only lowercase begin — " +
        "normalize migration SQL before shipping it.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("migration SQL normalized"),
    },
    {
      afterMs: 5,
      title: "fix(lambda): function URL auth type flips on every deploy",
      body:
        "createOrUpdateFunctionUrl writes AuthType NONE then the next deploy " +
        "flips it back — the observed-vs-desired diff compares the wrong field.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("auth type diffed on the right field"),
    },
  ],
  interactions: [
    "Watch the engineer desk's claim order: after the first task settles it should chain same-tag work, not alternate.",
  ],
};
