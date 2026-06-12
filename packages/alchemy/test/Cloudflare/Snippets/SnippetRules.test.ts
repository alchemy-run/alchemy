import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as snippets from "@distilled.cloud/cloudflare/snippets";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic snippet names — same value on every run.
const NAME_RULES_A = "alchemy_snippet_rules_a";
const NAME_RULES_B = "alchemy_snippet_rules_b";

const EXPRESSION_V1 = 'http.request.uri.path wildcard "/alchemy-snippet/*"';
const EXPRESSION_V2 = 'http.request.uri.path wildcard "/alchemy-snippet-v2/*"';
const EXPRESSION_B = 'http.request.uri.path wildcard "/alchemy-snippet-b/*"';

const code = `
export default {
  async fetch(request) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("x-alchemy-snippet", "rules-test");
    return newResponse;
  },
};
`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

interface WireRule {
  readonly snippet_name?: string;
  readonly expression?: string;
  readonly enabled?: boolean;
  readonly description?: string | null;
}

// Ride out eventually-consistent 403s (freshly-minted scoped tokens
// propagate slowly across Cloudflare's edge) on the test's own
// out-of-band verification calls.
const forbiddenRetryPolicy = {
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const listLiveRules = (zoneId: string) =>
  snippets.listRules({ zoneId }).pipe(
    Effect.map((result) =>
      Array.isArray(result) ? (result as WireRule[]) : [],
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

const findSnippet = (zoneId: string, name: string) =>
  snippets.listSnippets({ zoneId, perPage: 100 }).pipe(
    Effect.map((page) => page.result.find((s) => s.snippetName === name)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

// The zone's snippet-rule list is a singleton; purge any leftovers from
// interrupted runs so the test starts from a clean slate.
const purgeRules = (zoneId: string) =>
  snippets.deleteRule({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
    Effect.catchTag("SnippetRulesNotFound", () => Effect.void),
  );

test.provider(
  "snippet rules — create, update in place, destroy in dependency order",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRules(zoneId);

      // Create a snippet plus one rule activating it.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const snippet = yield* Cloudflare.Snippet("RulesSnippetA", {
            zoneId,
            name: NAME_RULES_A,
            code,
          }).pipe(adopt(true));
          const rules = yield* Cloudflare.SnippetRules("Rules", {
            zoneId,
            rules: [
              {
                snippetName: snippet.name,
                expression: EXPRESSION_V1,
                description: "alchemy snippet rules test",
              },
            ],
          }).pipe(adopt(true));
          return { snippet, rules };
        }),
      );

      expect(initial.rules.zoneId).toEqual(zoneId);
      expect(initial.rules.rules).toHaveLength(1);
      expect(initial.rules.rules[0].snippetName).toEqual(NAME_RULES_A);
      expect(initial.rules.rules[0].expression).toEqual(EXPRESSION_V1);
      expect(initial.rules.rules[0].enabled).toEqual(true);

      const live = yield* listLiveRules(zoneId);
      expect(live).toHaveLength(1);
      expect(live[0].snippet_name).toEqual(NAME_RULES_A);
      expect(live[0].expression).toEqual(EXPRESSION_V1);

      // Update: change the expression and add a second snippet + rule.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const snippetA = yield* Cloudflare.Snippet("RulesSnippetA", {
            zoneId,
            name: NAME_RULES_A,
            code,
          }).pipe(adopt(true));
          const snippetB = yield* Cloudflare.Snippet("RulesSnippetB", {
            zoneId,
            name: NAME_RULES_B,
            code,
          }).pipe(adopt(true));
          const rules = yield* Cloudflare.SnippetRules("Rules", {
            zoneId,
            rules: [
              {
                snippetName: snippetA.name,
                expression: EXPRESSION_V2,
                description: "alchemy snippet rules test v2",
              },
              {
                snippetName: snippetB.name,
                expression: EXPRESSION_B,
                enabled: false,
              },
            ],
          }).pipe(adopt(true));
          return { rules };
        }),
      );

      expect(updated.rules.rules).toHaveLength(2);
      expect(updated.rules.rules[0].expression).toEqual(EXPRESSION_V2);
      expect(updated.rules.rules[1].snippetName).toEqual(NAME_RULES_B);
      expect(updated.rules.rules[1].enabled).toEqual(false);

      const liveUpdated = yield* listLiveRules(zoneId);
      expect(liveUpdated).toHaveLength(2);
      expect(liveUpdated[0].expression).toEqual(EXPRESSION_V2);
      expect(liveUpdated[1].snippet_name).toEqual(NAME_RULES_B);

      // Destroy — rules must be deleted before the snippets they
      // reference (dependency ordering via the `snippetName` input).
      yield* stack.destroy();

      const liveGone = yield* listLiveRules(zoneId);
      expect(liveGone).toHaveLength(0);
      expect(yield* findSnippet(zoneId, NAME_RULES_A)).toBeUndefined();
      expect(yield* findSnippet(zoneId, NAME_RULES_B)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
