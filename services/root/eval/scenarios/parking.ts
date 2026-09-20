import type { Scenario } from "../scenario.ts";

/**
 * PARKING — tasks blocked BY DESIGN, where parking (or handing off)
 * is the CORRECT outcome. Two shapes each for park and handoff: one
 * reply carries its DISPOSITION line (code parses it), one forgets
 * the line so the judged fallback (the disposition Choice) has to
 * read the same conclusion out of prose — that judged edge is scored
 * as agreement when the real System One is on.
 */
export const parking: Scenario = {
  name: "parking",
  description:
    "Blocked-by-design tasks — parking/handoff is correct; one of each is judged from prose",
  arrivals: [
    {
      afterMs: 0,
      title: "feat(magic): Magic Transit site resource",
      body:
        "Implement the Magic Transit site resource. NOTE: the testing account " +
        "is not onboarded to Magic Transit (API code 1012) — the live " +
        "lifecycle cannot run until the entitlement lands.",
      tags: ["cloudflare"],
      expect: { disposition: "park", maxRounds: 1 },
      rounds: [
        {
          member: "engineer",
          reply:
            "Probed the API — code 1012, account not onboarded. Implemented " +
            "the resource and gated the lifecycle test.\n" +
            "DISPOSITION: park — blocked on the Magic Transit entitlement",
          expect: "park",
        },
      ],
    },
    {
      afterMs: 1,
      title: "test(dlp): enable the DLP live suite",
      body:
        "Turn on the DLP lifecycle tests. Requires the CLOUDFLARE_TEST_DLP " +
        "entitlement, which the testing account does not have.",
      tags: ["cloudflare"],
      expect: { disposition: "park", maxRounds: 1 },
      rounds: [
        {
          // no DISPOSITION line — the judged fallback must read "park"
          member: "engineer",
          reply:
            "The suite is written and skipIf-gated, but the account lacks the " +
            "DLP entitlement — every live call returns the typed entitlement " +
            "error. Nothing more can move until access is granted.",
          expect: "park",
        },
      ],
    },
    {
      afterMs: 2,
      title: "fix(infra): renew the DNS registrar account",
      body:
        "The registrar account renewal is manual, card-in-hand work on the " +
        "registrar's console — human-owned, not desk work.",
      tags: ["org"],
      expect: { disposition: "handoff", maxRounds: 1 },
      rounds: [
        {
          member: "engineer",
          reply:
            "This is human-owned registrar-console work; a desk has no card " +
            "and no login.\n" +
            "DISPOSITION: handoff — belongs to a human owner",
          expect: "handoff",
        },
      ],
    },
  ],
  interactions: [
    "Parked cards should carry their reason; the handoff should land BACK in the inbox for you to re-route.",
  ],
};
