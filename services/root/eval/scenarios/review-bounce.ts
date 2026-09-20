import type { Scenario } from "../scenario.ts";

/**
 * REVIEW BOUNCE — the review gate's Noul (Review.ts) under both
 * verdicts: one task whose first result names a defect and must
 * bounce (changes_requested → back to ready → re-claimed → approved),
 * and one control task approved first pass. Scripted mode scripts the
 * reviewer's replies and scores the Noul's agreement; live mode just
 * records the verdicts the real reviewer drew.
 */
export const reviewBounce: Scenario = {
  name: "review-bounce",
  description:
    "First review demands changes and bounces; second pass approves — Noul agreement",
  arrivals: [
    {
      afterMs: 0,
      title: "fix(do): alarm eviction test is racy",
      body:
        "The Durable Object alarm eviction test polls without a bound and " +
        "flakes under load. Fix the alarm re-registration AND make the test " +
        "deterministic.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 2 },
      rounds: [
        {
          member: "engineer",
          reply:
            "Re-registered the alarm in the constructor.\n" +
            "DISPOSITION: complete — alarm re-registration on wake",
        },
        {
          member: "reviewer",
          reply:
            "Changes needed: the eviction test is still racy — the retry is " +
            "unbounded. Bound it before this can merge.",
          expect: "changes_requested",
        },
        {
          member: "engineer",
          reply:
            "Bounded the retry; the test is deterministic now.\n" +
            "DISPOSITION: complete — addressed the review",
        },
        {
          member: "reviewer",
          reply: "LGTM — deterministic now.",
          expect: "approved",
        },
      ],
    },
    {
      afterMs: 1,
      title: "fix(kv): list pagination drops the last page",
      body:
        "KV list stops one cursor early when the final page is exactly the " +
        "limit — carry list_complete through the loop.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: [
        {
          member: "engineer",
          reply:
            "Carried list_complete through; added the exact-limit case.\n" +
            "DISPOSITION: complete — pagination carries list_complete",
        },
        {
          member: "reviewer",
          reply: "LGTM — the exact-limit case pins it.",
          expect: "approved",
        },
      ],
    },
  ],
  interactions: [
    "The bounced task's timeline should show changes_requested with the review attached, then a second engineer round.",
  ],
};
