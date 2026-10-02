import * as AdoptPolicy from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import { Provider as ProviderService } from "@/Provider.ts";
import * as RemovalPolicy from "@/RemovalPolicy";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { MinimumLogLevel } from "effect/References";
import {
  notFound,
  session,
  stubCloudflare,
  type StubCall,
} from "../StubCloudflare.ts";
const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare intermittently blocks *all* zone creation on an account with
// error 1052 ("An error(zone setup) has occurred and it has been logged");
// the block is account-level and can persist for hours. The unresolved-zone
// test below provisions a fresh zone, so soft-skip it while the account is in
// that state; every other failure propagates unchanged.
const softSkipWhenZoneCreationBlocked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | undefined, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      // Match by tag rather than `instanceof zones.ZoneCreationBlocked`: the
      // error is constructed inside the provider's copy of the distilled
      // module, which vitest resolves as a separate module instance from this
      // test's import, so `instanceof` across that boundary is always false.
      const blocked = cause.reasons
        .map((reason) =>
          Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined,
        )
        .some(
          (value) =>
            Predicate.hasProperty(value, "_tag") &&
            value._tag === "ZoneCreationBlocked",
        );
      return blocked
        ? Effect.logWarning(
            "Cloudflare has zone creation blocked on this account (error 1052) — skipping zone-provisioning ruleset assertions",
          ).pipe(Effect.as(undefined))
        : Effect.failCause(cause);
    }),
  );

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_RULESET_ZONE_NAME ?? "alchemy-test-2.us";
// The unresolved-zone test owns a phase entrypoint on a *separate* zone so it
// never clobbers the CRUD test's rules.
const unresolvedZoneName =
  process.env.CLOUDFLARE_TEST_RULESET_ZONE_NAME_2 ??
  "alchemy-test-unresolved.us";
const phase = "http_request_firewall_custom";
type TestRulesetPhase = typeof phase;

// The CRUD test and the `list` test both manage the same zone+phase entrypoint
// on `alchemy-test-2.us`; run them serially so they can't clobber each other
// under the global concurrent test config.
describe.sequential(
  "Ruleset",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:ruleset",
      "provider:cloudflare:zone",
      "live",
    ],
  },
  () => {
    test.provider(
      "creates, updates, and deletes a zone phase entrypoint ruleset",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: zoneName,
              }).pipe(AdoptPolicy.adopt(true));
              return yield* Cloudflare.Ruleset.Ruleset("TestRuleset", {
                zone,
                phase,
                rules: [
                  {
                    description: "Alchemy test rule",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_test__"',
                    action: "block",
                  },
                ],
              });
            }),
          );

          expect(initial.phase).toEqual(phase);
          expect(initial.rules).toHaveLength(1);

          // Verify the rule actually exists in Cloudflare, not just in the
          // stack output.
          const createdRules = yield* getPhaseRules(initial.zoneId, phase);
          expect(createdRules).toHaveLength(1);
          expect(createdRules[0]).toMatchObject({
            description: "Alchemy test rule",
            action: "block",
            expression: 'http.request.uri.path eq "/__alchemy_ruleset_test__"',
          });

          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: zoneName,
              }).pipe(AdoptPolicy.adopt(true));
              return yield* Cloudflare.Ruleset.Ruleset("TestRuleset", {
                zone,
                phase,
                rules: [
                  {
                    description: "Updated Alchemy test rule",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_test__"',
                    action: "managed_challenge",
                  },
                ],
              });
            }),
          );

          expect(updated.zoneId).toEqual(initial.zoneId);
          expect(updated.rules[0]?.description).toEqual(
            "Updated Alchemy test rule",
          );
          expect(updated.rules[0]?.action).toEqual("managed_challenge");

          // Verify the update landed in Cloudflare itself.
          const updatedRules = yield* getPhaseRules(initial.zoneId, phase);
          expect(updatedRules).toHaveLength(1);
          expect(updatedRules[0]).toMatchObject({
            description: "Updated Alchemy test rule",
            action: "managed_challenge",
          });

          yield* stack.destroy();

          // Confirm the phase entrypoint was emptied in Cloudflare on destroy.
          const actualRules = yield* getPhaseRules(initial.zoneId, phase);
          expect(actualRules).toEqual([]);
        }).pipe(logLevel),
    );

    test.provider(
      "destroy removes only its own rules and keeps the entrypoint",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: zoneName,
              }).pipe(AdoptPolicy.adopt(true));
              return yield* Cloudflare.Ruleset.Ruleset("OwnedRules", {
                zone,
                phase,
                rules: [
                  {
                    description: "Alchemy owned rule",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_owned__"',
                    action: "block",
                  },
                ],
              });
            }),
          );

          // A rule added outside this stack after the deploy.
          yield* rulesets.createRuleForZone({
            zoneId: deployed.zoneId,
            rulesetId: deployed.rulesetId,
            body: {
              description: "Foreign rule",
              expression:
                'http.request.uri.path eq "/__alchemy_ruleset_foreign__"',
              action: "block",
            },
          });

          yield* stack.destroy();

          const entrypoint = yield* rulesets.getPhasForZone({
            zoneId: deployed.zoneId,
            rulesetPhase: phase,
          });
          expect(entrypoint.id).toEqual(deployed.rulesetId);
          expect(entrypoint.rules.map((r) => r.description)).toEqual([
            "Foreign rule",
          ]);

          yield* Effect.forEach(entrypoint.rules, (rule) =>
            rulesets.deleteRuleForZone({
              zoneId: deployed.zoneId,
              rulesetId: entrypoint.id,
              ruleId: rule.id!,
            }),
          );
        }).pipe(logLevel),
    );

    test.provider(
      "creates and tears down a ruleset whose zone is provisioned in the same deploy",
      (stack) =>
        Effect.gen(function* () {
          // Start from a clean slate so a leftover zone/ruleset from an
          // interrupted run can't mask a regression.
          yield* stack.destroy();

          // The zone is created in the same deploy as the ruleset, so its `zoneId`
          // is an unresolved Output while the ruleset is planned. `adopt(true)`
          // takes over a leftover zone from a prior run; `destroy()` overrides the
          // zone's default `retain` so it is actually deleted on teardown.
          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: unresolvedZoneName,
              }).pipe(AdoptPolicy.adopt(true), RemovalPolicy.destroy());
              return yield* Cloudflare.Ruleset.Ruleset("TestRuleset", {
                zone,
                phase,
                rules: [
                  {
                    description: "Unresolved zone rule v1",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_unresolved__"',
                    action: "block",
                  },
                ],
              });
            }),
          );

          const createdRules = yield* getPhaseRules(initial.zoneId, phase);
          expect(createdRules).toHaveLength(1);
          expect(createdRules[0]).toMatchObject({
            description: "Unresolved zone rule v1",
            action: "block",
          });

          // Re-deploy with changed rules; the ruleset must update in place.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: unresolvedZoneName,
              }).pipe(AdoptPolicy.adopt(true), RemovalPolicy.destroy());
              return yield* Cloudflare.Ruleset.Ruleset("TestRuleset", {
                zone,
                phase,
                rules: [
                  {
                    description: "Unresolved zone rule v2",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_unresolved__"',
                    action: "managed_challenge",
                  },
                ],
              });
            }),
          );

          expect(updated.zoneId).toEqual(initial.zoneId);
          const updatedRules = yield* getPhaseRules(updated.zoneId, phase);
          expect(updatedRules).toHaveLength(1);
          expect(updatedRules[0]).toMatchObject({
            description: "Unresolved zone rule v2",
            action: "managed_challenge",
          });

          yield* stack.destroy();

          // The zone itself is deleted (destroy, not retain) — assert it's gone in
          // Cloudflare. (Querying the phase entrypoint here is meaningless: the
          // zone no longer exists, so Cloudflare answers Unauthorized, not 404.)
          const { accountId } = yield* yield* CloudflareEnvironment;
          const zoneAfter = yield* findZoneByName({
            accountId,
            name: unresolvedZoneName,
          });
          expect(zoneAfter).toBeUndefined();
        }).pipe(softSkipWhenZoneCreationBlocked, logLevel),
    );

    // A `creating` state row persisted before upstream Outputs resolve cannot
    // round-trip Output-valued props — the `zone` prop deserializes as
    // `undefined`. The engine's creating-with-no-attr recovery path then calls
    // `read` with those junk props as `olds` and `output: undefined`. Before the
    // #770 guard, `zoneIdOf(olds.zone)` dereferenced `.zoneId` on `undefined`
    // and crashed the deploy; after it, `read` returns "not found" and
    // `reconcile` re-converges the phase entrypoint from the resolved news.
    test.provider(
      "recovers a half-created ruleset whose creating-state lost the Output-valued zone (#736)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployRuleset = () =>
            stack.deploy(
              Effect.gen(function* () {
                const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                  name: zoneName,
                }).pipe(AdoptPolicy.adopt(true));
                return yield* Cloudflare.Ruleset.Ruleset("WedgedRuleset", {
                  zone,
                  phase,
                  rules: [
                    {
                      description: "Alchemy wedged recovery rule",
                      expression:
                        'http.request.uri.path eq "/__alchemy_ruleset_wedged__"',
                      action: "block",
                    },
                  ],
                });
              }),
            );

          const created = yield* deployRuleset();

          // Rewrite the ruleset's persisted row into the wedged shape an
          // interrupted deploy leaves behind: `creating`, no attributes, and the
          // Output-valued `zone` prop lost in the round-trip.
          const state = yield* yield* State;
          const stage = stack.stage;
          const fqns = yield* state.list({ stack: stack.name, stage });
          const rows = yield* Effect.forEach(fqns, (fqn) =>
            state
              .get({ stack: stack.name, stage, fqn })
              .pipe(Effect.map((row) => ({ fqn, row }))),
          );
          const wedged = rows.find(
            (r): r is { fqn: string; row: ResourceState } =>
              isResourceState(r.row) &&
              r.row.resourceType === "Cloudflare.Ruleset.Ruleset",
          );
          if (!wedged) {
            return yield* Effect.die(
              new Error(
                "no Cloudflare.Ruleset.Ruleset state row found after deploy",
              ),
            );
          }
          yield* state.set({
            stack: stack.name,
            stage,
            fqn: wedged.fqn,
            value: {
              ...wedged.row,
              status: "creating",
              attr: undefined,
              props: { ...wedged.row.props, zone: undefined },
            },
          });

          // Before the fix this crashed in `read` with
          // `TypeError: undefined is not an object (evaluating 'zone.zoneId')`.
          const recovered = yield* deployRuleset();
          expect(recovered.rulesetId).toEqual(created.rulesetId);
          expect(recovered.zoneId).toEqual(created.zoneId);

          // The recovered entrypoint converged to the desired rules.
          const recoveredRules = yield* getPhaseRules(recovered.zoneId, phase);
          expect(recoveredRules).toHaveLength(1);
          expect(recoveredRules[0]).toMatchObject({
            description: "Alchemy wedged recovery rule",
            action: "block",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    // Canonical `list()` test (zone-scoped collection): enumerate every zone via
    // `listAllZones`, list each zone's rulesets, keep the phase entrypoints, and
    // hydrate them. Deploy a ruleset on the standing test zone, then assert it is
    // present in the exhaustively-paginated result.
    //
    // GATED: `list()` hydrates *every* phase entrypoint across *every* zone via
    // `getPhasForZone`. The standing test zone (alchemy-test-2.us) carries a
    // pre-existing `http_request_dynamic_redirect` entrypoint whose redirect rule
    // returns `action_parameters.from_value.status_code` as a NUMBER (301), but
    // distilled's `GetPhasResponse` schema types `statusCode` as string-only
    // (`Schema.Literals(["301",...]) | String`). Decode fails with the exact
    // error:
    //   CloudflareHttpError { status: 200, statusText: "Schema decode failed" }
    //   GET /zones/{zone_id}/rulesets/phases/{rulesetPhase}/entrypoint
    // NEEDED DISTILLED PATCH (rulesets/getPhas.json, response): the redirect
    // variant's `actionParameters.fromValue.statusCode` (and the matching
    // `getRuleset` / list-version response schemas) must also accept `Number`.
    // Gated on CLOUDFLARE_TEST_RULESET_LIST until that patch lands.
    test.provider.skipIf(!process.env.CLOUDFLARE_TEST_RULESET_LIST)(
      "list enumerates the deployed zone phase entrypoint",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* Cloudflare.Zone.Zone("TestZone", {
                name: zoneName,
              }).pipe(AdoptPolicy.adopt(true));
              return yield* Cloudflare.Ruleset.Ruleset("TestRuleset", {
                zone,
                phase,
                rules: [
                  {
                    description: "Alchemy list test rule",
                    expression:
                      'http.request.uri.path eq "/__alchemy_ruleset_list_test__"',
                    action: "block",
                  },
                ],
              });
            }),
          );

          const provider = yield* Provider.findProvider(
            Cloudflare.Ruleset.Ruleset,
          );
          const all = yield* provider.list();

          expect(all.length).toBeGreaterThan(0);
          expect(
            all.some(
              (r) =>
                r.rulesetId === deployed.rulesetId &&
                r.zoneId === deployed.zoneId &&
                r.phase === phase,
            ),
          ).toBe(true);

          yield* stack.destroy();
        }).pipe(logLevel),
    );
  },
);

const getPhaseRules = Effect.fn(function* (
  zoneId: string,
  phase: TestRulesetPhase,
) {
  return yield* rulesets
    .getPhasForZone({
      zoneId,
      rulesetPhase: phase,
    })
    .pipe(
      Effect.map((ruleset) => ruleset.rules ?? []),
      Effect.catchTag("RulesetNotFound", () => Effect.succeed([])),
    );
});

const ZONE_ID = "zone-1";
const RULESET_ID = "entrypoint-1";

const rule = (id: string, description: string) => ({
  id,
  description,
  expression: `http.request.uri.path eq "/${id}"`,
  action: "block",
  enabled: true,
  version: "1",
  last_updated: "2026-01-01T00:00:00Z",
});

const entrypoint = (rules: ReturnType<typeof rule>[]) => ({
  id: RULESET_ID,
  kind: "zone",
  name: "zone entrypoint",
  phase,
  rules,
  version: "3",
  last_updated: "2026-01-01T00:00:00Z",
});

const deployedOutput = (
  rules: ReturnType<typeof rule>[],
): Cloudflare.Ruleset.Ruleset["Attributes"] => ({
  rulesetId: RULESET_ID,
  zoneId: ZONE_ID,
  kind: "zone",
  name: "zone entrypoint",
  phase,
  description: undefined,
  rules: rules.map(({ id, description, expression, action, enabled }) => ({
    id,
    description,
    expression,
    action,
    enabled,
  })) as Cloudflare.Ruleset.Ruleset["Attributes"]["rules"],
  lastUpdated: "2026-01-01T00:00:00Z",
  version: "2",
});

/** Run the real provider delete against a stubbed API; return its requests. */
const recordDelete = (
  output: Cloudflare.Ruleset.Ruleset["Attributes"],
  respond: (call: StubCall) => unknown,
) =>
  Effect.gen(function* () {
    const stub = stubCloudflare(respond);
    yield* Effect.gen(function* () {
      const provider = yield* ProviderService<Cloudflare.Ruleset.Ruleset>(
        "Cloudflare.Ruleset.Ruleset",
      );
      yield* provider.delete({
        id: "WafRules",
        fqn: "WafRules",
        instanceId: "0123456789abcdef0123456789abcdef",
        olds: {
          zone: undefined as never,
          phase,
          rules: [],
        },
        output,
        bindings: [] as never,
        session,
      });
    }).pipe(
      Effect.provide(Cloudflare.Ruleset.RulesetProvider()),
      Effect.provide(stub.layer),
    );
    return stub.calls;
  });

const mutations = (calls: StubCall[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);

describe(
  "Ruleset delete (offline)",
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:ruleset",
      "local",
    ],
  },
  () => {
    it.effect(
      "removes only the rules it deployed and keeps the entrypoint",
      () =>
        Effect.gen(function* () {
          const ours = [rule("ours-1", "a"), rule("ours-2", "b")];
          const calls = yield* recordDelete(deployedOutput(ours), (call) =>
            call.method === "GET"
              ? entrypoint([ours[0], rule("foreign-1", "dashboard"), ours[1]])
              : entrypoint([rule("foreign-1", "dashboard")]),
          );

          expect(mutations(calls)).toEqual([
            `DELETE /zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/ours-1`,
            `DELETE /zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/ours-2`,
          ]);
        }),
    );

    it.effect("never deletes the entrypoint ruleset itself", () =>
      Effect.gen(function* () {
        const ours = [rule("ours-1", "a")];
        const calls = yield* recordDelete(deployedOutput(ours), (call) =>
          call.method === "GET" ? entrypoint(ours) : entrypoint([]),
        );

        expect(mutations(calls)).toEqual([
          `DELETE /zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/ours-1`,
        ]);
        expect(
          calls.some(
            (c) =>
              c.method === "DELETE" &&
              c.path === `/zones/${ZONE_ID}/rulesets/${RULESET_ID}`,
          ),
        ).toBe(false);
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
      }),
    );

    it.effect("skips rules that were already removed", () =>
      Effect.gen(function* () {
        const calls = yield* recordDelete(
          deployedOutput([rule("ours-1", "a")]),
          () => entrypoint([rule("foreign-1", "dashboard")]),
        );

        expect(mutations(calls)).toEqual([]);
      }),
    );

    it.effect("is a no-op when the entrypoint does not exist", () =>
      Effect.gen(function* () {
        const calls = yield* recordDelete(
          deployedOutput([rule("ours-1", "a")]),
          () => notFound(10003, "Could not find entrypoint ruleset"),
        );

        expect(calls.map((c) => c.method)).toEqual(["GET"]);
      }),
    );
  },
);
