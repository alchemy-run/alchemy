/**
 * DEPTH.md row 5 — Tenant cohabitation chain.
 *
 * ONE `Vercel.Project` hosts four cohabiting resources:
 *
 *   - a tenant `Vercel.Function` (preview mode, `project:` ref) with
 *     per-deployment env delivered via `.vc-config.json`
 *   - a `Vercel.ProjectEnv` row (`COHAB_FLAG`) in shared project env
 *   - a `Vercel.FirewallConfig` (custom WAF rule)
 *   - a `Vercel.Webhook` scoped to the project via `projectIds` (an
 *     interaction surface no isolation suite exercises)
 *
 * Cycles (each asserts BOTH what changed AND what stayed stable, with
 * out-of-band reads via distilled and engine-level plan assertions):
 *
 *   1. deploy all → baseline; settled plan is all-noop
 *   2. firewall rule escalation ONLY → version bumps; siblings untouched,
 *      no redeploy of the tenant
 *   3. ProjectEnv value rotation ONLY → row updated in place; siblings
 *      untouched, no redeploy of the tenant (sibling project env is NOT
 *      part of the tenant's per-deployment env identity)
 *   4. webhook event-list change ONLY → REPLACEMENT (new id + secret, old
 *      hook gone); siblings untouched
 *   5. tenant greeting change ONLY → new immutable deployment behind the
 *      STABLE per-stage alias; siblings untouched
 *   6. CONFLICT: tenant env key colliding with the sibling ProjectEnv row
 *      (`COHAB_FLAG`) → typed `Vercel.TenantEnvConflict`, no deployment
 *      created, recovery redeploy is a skip-on-hash noop
 *   7. tenant removal ONLY → its alias + meta-stamped deployments drain
 *      (including the auto-promoted production one — see below);
 *      project + env row + firewall + webhook all intact
 *   8. full destroy → project (cascading env + firewall) and webhook gone
 *
 * Platform finding this chain surfaced (probe-verified,
 * `.probes/depth5-target-inference.ts`): a no-target (preview-intent)
 * deployment into a project with NO production deployment is
 * auto-promoted to production by Vercel; once a production deployment
 * exists, the same call lands a true preview. The provider fix that came
 * out of it: the tenant destroy refusal (`TenantProductionDeleteRefused`)
 * keys on the tenant's declared `target` intent, not the observed
 * auto-promoted target — a preview-intent tenant always drains cleanly.
 *
 * Engine-deadlock rule respected: no cycle replaces a resource while
 * simultaneously removing one of its dependencies (the webhook replacement
 * in cycle 4 keeps the project deployed; the tenant removal in cycle 7
 * replaces nothing).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as aliases from "@distilled.cloud/vercel/aliases";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import * as security from "@distilled.cloud/vercel/security";
import * as webhooks from "@distilled.cloud/vercel/webhooks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/handler.ts", import.meta.url).pathname;

// Deterministic, chain-unique host project name (constant across runs).
const HOST = "alchemy-chain-tenant-cohab";
const HOOK_URL = "https://example.com/alchemy/chains/tenant-cohabitation";
const ENV_KEY = "COHAB_FLAG";

// ── The chain program ────────────────────────────────────────────────────

interface Knobs {
  readonly firewall: Vercel.FirewallRuleAction;
  readonly envValue: string;
  readonly events: string[];
  readonly greeting: string;
  /** Tenant per-deployment env key; the conflict cycle points it at ENV_KEY. */
  readonly tenantKey?: string;
}

const wafRule = (action: Vercel.FirewallRuleAction): Vercel.FirewallRule => ({
  name: "block-admin",
  conditionGroup: [
    { conditions: [{ type: "path", op: "pre", value: "/admin" }] },
  ],
  action: { action },
});

/** The four sibling resources (everything but the tenant Function). */
const siblings = (k: Knobs) =>
  Effect.gen(function* () {
    const project = yield* Vercel.Project("Host", { name: HOST });
    const env = yield* Vercel.ProjectEnv("Flag", {
      project: project.projectId,
      key: ENV_KEY,
      value: k.envValue,
      comment: "tenant-cohabitation sibling",
    });
    const waf = yield* Vercel.FirewallConfig("Waf", {
      projectId: project.projectId,
      rules: [wafRule(k.firewall)],
    });
    const hook = yield* Vercel.Webhook("Hook", {
      url: HOOK_URL,
      events: k.events,
      projectIds: [project.projectId],
    });
    return { project, env, waf, hook };
  });

/** Siblings + the preview tenant Function. */
const full = (k: Knobs) =>
  Effect.gen(function* () {
    const rest = yield* siblings(k);
    const tenant = yield* Vercel.Function("Tenant", {
      main: fixtureMain,
      project: rest.project.projectId,
      env: { [k.tenantKey ?? "GREETING"]: k.greeting },
    });
    return { ...rest, tenant };
  });

// ── Out-of-band observation helpers (distilled) ──────────────────────────

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

const observeProject = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* projects.getProject({ idOrName: projectId, ...team }).pipe(
      Effect.map((p): projects.GetProjectResponse | undefined => p),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

/** The env row by id — single-env GET returns the decrypted value. */
const observeEnvRow = (projectId: string, envId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const row = yield* projects.getProjectEnv({
      idOrName: projectId,
      id: envId,
      ...team,
    });
    return row as { value?: string; updatedAt?: number; key?: string };
  });

const observeFirewall = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* security
      .getFirewallConfig({ configVersion: "active", projectId, ...team })
      .pipe(
        Effect.map(
          (doc): security.GetFirewallConfigResponse | undefined => doc,
        ),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
  });

const observeHook = (id: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* webhooks.getWebhook({ id, ...team }).pipe(
      Effect.map((hook): webhooks.GetWebhookResponse | undefined => hook),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

const observeAlias = (aliasName: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* aliases.getAlias({ idOrAlias: aliasName, ...team }).pipe(
      Effect.map((a): unknown | undefined => a),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

/** Live (non-deleted) deployments on the host project. */
const liveDeployments = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const page = yield* deployments.getDeployments({
      projectId,
      limit: 100,
      ...team,
    });
    return page.deployments.filter((d) => d.readyState !== "DELETED");
  });

/** The project's automation bypass secret (minted by the tenant reconcile). */
const readBypass = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* observeProject(projectId);
    expect(project).toBeDefined();
    const entry = Object.entries(project!.protectionBypass ?? {}).find(
      ([, value]) =>
        (value as { scope?: string } | undefined)?.scope ===
        "automation-bypass",
    );
    expect(entry).toBeDefined();
    return entry![0];
  });

/**
 * Drive the tenant's per-stage alias through the SSO bypass until it serves
 * the expected greeting (alias re-points + fresh deployments take a few
 * seconds to settle — bounded).
 */
const pollGreeting = (url: string, bypass: string, expected: string) =>
  Effect.gen(function* () {
    const body = yield* HttpClient.get(url, {
      headers: { "x-vercel-protection-bypass": bypass },
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.fail(new Error(`status ${response.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (b) => (b as { greeting: string | null }).greeting === expected,
        times: 15,
      }),
    );
    expect((body as { greeting: string | null }).greeting).toEqual(expected);
  });

/** Engine-level plan action for a logical id. */
const actionOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

const SIBLING_IDS = ["Host", "Flag", "Waf", "Hook"] as const;
const ALL_IDS = [...SIBLING_IDS, "Tenant"] as const;

/** Robust failure → text (aggregated causes may resist stringification). */
const describeFailure = (failure: unknown): string => {
  const base = String(failure);
  try {
    return `${base} ${JSON.stringify(failure)}`;
  } catch {
    return base;
  }
};

/** Bounded typed wait until the host project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const gone = yield* observeProject(projectId).pipe(
      Effect.map((p) => p === undefined),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

// ── The chain ────────────────────────────────────────────────────────────

test.provider(
  "tenant cohabitation: five resources on one project — independent cycles never clobber siblings, env conflict is typed, tenant destroy is surgical",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // ═══ CYCLE 1: deploy the full cohabitation ═══════════════════════
      const v1: Knobs = {
        firewall: "challenge",
        envValue: "cohab-v1",
        events: ["deployment.created"],
        greeting: "greet-v1",
      };
      const c1 = yield* stack.deploy(full(v1));

      expect(c1.project.projectId).toBeDefined();
      expect(c1.env.projectId).toEqual(c1.project.projectId);
      expect(c1.waf.projectId).toEqual(c1.project.projectId);
      expect(c1.hook.projectIds).toEqual([c1.project.projectId]);
      expect(c1.tenant.projectId).toEqual(c1.project.projectId);
      expect(c1.tenant.stageAlias).toBeDefined();
      expect(c1.tenant.url).toEqual(`https://${c1.tenant.stageAlias!.alias}`);

      // Out-of-band baseline.
      const bypass = yield* readBypass(c1.project.projectId);
      const env1 = yield* observeEnvRow(c1.project.projectId, c1.env.envId);
      expect(env1.value).toEqual("cohab-v1");
      const waf1 = yield* observeFirewall(c1.project.projectId);
      expect(waf1!.firewallEnabled).toEqual(true);
      expect(waf1!.rules).toHaveLength(1);
      const hook1 = yield* observeHook(c1.hook.webhookId);
      expect(hook1).toBeDefined();
      expect([...hook1!.events]).toEqual(["deployment.created"]);
      const deps1 = yield* liveDeployments(c1.project.projectId);
      expect(deps1).toHaveLength(1);
      expect(deps1[0]!.uid).toEqual(c1.tenant.deploymentId);
      // Platform fact (probe-verified, .probes/depth5-target-inference.ts):
      // the shared project had NO production deployment, so Vercel
      // auto-promoted this first deployment to production even though the
      // tenant omitted `target` (preview intent). Cycle 5 pins the
      // complementary inference (production exists → preview).
      expect(deps1[0]!.target).toEqual("production");
      expect((deps1[0] as { readySubstate?: string }).readySubstate).toEqual(
        "PROMOTED",
      );
      yield* pollGreeting(`${c1.tenant.url}/env`, bypass, "greet-v1");

      // Settled: replanning the identical program is all-noop.
      const settled = yield* stack.plan(full(v1));
      for (const id of ALL_IDS) expect(actionOf(settled, id)).toBe("noop");

      // ═══ CYCLE 2: firewall escalation ONLY ═══════════════════════════
      const v2: Knobs = { ...v1, firewall: "deny" };
      const plan2 = yield* stack.plan(full(v2));
      expect(actionOf(plan2, "Waf")).toBe("update");
      for (const id of ALL_IDS.filter((i) => i !== "Waf")) {
        expect(actionOf(plan2, id)).toBe("noop");
      }

      const c2 = yield* stack.deploy(full(v2));
      // Changed: the firewall document (new version, escalated action).
      expect(c2.waf.version).toBeGreaterThan(c1.waf.version);
      const waf2 = yield* observeFirewall(c1.project.projectId);
      const waf2Rule = waf2!.rules[0]! as {
        action: { mitigate?: { action?: string } };
      };
      expect(waf2Rule.action.mitigate?.action).toEqual("deny");
      // Stable: tenant deployment (id AND count — no hidden redeploys),
      // env row (same updatedAt), webhook (same id + secret), alias.
      expect(c2.tenant.deploymentId).toEqual(c1.tenant.deploymentId);
      expect(yield* liveDeployments(c1.project.projectId)).toHaveLength(1);
      const env2 = yield* observeEnvRow(c1.project.projectId, c1.env.envId);
      expect(env2.updatedAt).toEqual(env1.updatedAt);
      expect(c2.hook.webhookId).toEqual(c1.hook.webhookId);
      expect(c2.hook.secret).toEqual(c1.hook.secret);
      expect(c2.tenant.stageAlias!.alias).toEqual(c1.tenant.stageAlias!.alias);

      // ═══ CYCLE 3: ProjectEnv value rotation ONLY ═════════════════════
      const v3: Knobs = { ...v2, envValue: "cohab-v2" };
      const plan3 = yield* stack.plan(full(v3));
      expect(actionOf(plan3, "Flag")).toBe("update");
      for (const id of ALL_IDS.filter((i) => i !== "Flag")) {
        expect(actionOf(plan3, id)).toBe("noop");
      }

      const c3 = yield* stack.deploy(full(v3));
      // Changed: the env row, in place (same id, new value).
      expect(c3.env.envId).toEqual(c1.env.envId);
      const env3 = yield* observeEnvRow(c1.project.projectId, c1.env.envId);
      expect(env3.value).toEqual("cohab-v2");
      expect(env3.updatedAt).not.toEqual(env1.updatedAt);
      // Stable: tenant deployment (sibling project env is NOT part of the
      // tenant's per-deployment identity), firewall version, webhook.
      expect(c3.tenant.deploymentId).toEqual(c1.tenant.deploymentId);
      expect(yield* liveDeployments(c1.project.projectId)).toHaveLength(1);
      expect((yield* observeFirewall(c1.project.projectId))!.version).toEqual(
        c2.waf.version,
      );
      expect(c3.hook.webhookId).toEqual(c1.hook.webhookId);

      // ═══ CYCLE 4: webhook event change ONLY → REPLACEMENT ════════════
      const v4: Knobs = {
        ...v3,
        events: ["deployment.created", "deployment.succeeded"],
      };
      const plan4 = yield* stack.plan(full(v4));
      expect(actionOf(plan4, "Hook")).toBe("replace");
      for (const id of ALL_IDS.filter((i) => i !== "Hook")) {
        expect(actionOf(plan4, id)).toBe("noop");
      }

      const c4 = yield* stack.deploy(full(v4));
      // Changed: new webhook identity + fresh secret; old hook gone.
      expect(c4.hook.webhookId).not.toEqual(c1.hook.webhookId);
      expect(c4.hook.secret).not.toEqual(c1.hook.secret);
      expect([...c4.hook.events].sort()).toEqual([
        "deployment.created",
        "deployment.succeeded",
      ]);
      expect(yield* observeHook(c1.hook.webhookId)).toBeUndefined();
      const hook4 = yield* observeHook(c4.hook.webhookId);
      expect(hook4).toBeDefined();
      // Stable: everything else.
      expect(c4.tenant.deploymentId).toEqual(c1.tenant.deploymentId);
      expect(yield* liveDeployments(c1.project.projectId)).toHaveLength(1);
      expect((yield* observeFirewall(c1.project.projectId))!.version).toEqual(
        c2.waf.version,
      );
      expect(
        (yield* observeEnvRow(c1.project.projectId, c1.env.envId)).updatedAt,
      ).toEqual(env3.updatedAt);

      // ═══ CYCLE 5: tenant code/env change ONLY → new deployment ═══════
      const v5: Knobs = { ...v4, greeting: "greet-v2" };
      const plan5 = yield* stack.plan(full(v5));
      expect(actionOf(plan5, "Tenant")).toBe("update");
      for (const id of SIBLING_IDS) expect(actionOf(plan5, id)).toBe("noop");

      const c5 = yield* stack.deploy(full(v5));
      // Changed: a new immutable deployment serving the new env…
      expect(c5.tenant.deploymentId).not.toEqual(c1.tenant.deploymentId);
      // …behind the STABLE per-stage alias (same hostname, same URL).
      expect(c5.tenant.stageAlias!.alias).toEqual(c1.tenant.stageAlias!.alias);
      expect(c5.tenant.url).toEqual(c1.tenant.url);
      yield* pollGreeting(`${c5.tenant.url}/env`, bypass, "greet-v2");
      // Stable: siblings' observed cloud state.
      expect((yield* observeFirewall(c1.project.projectId))!.version).toEqual(
        c2.waf.version,
      );
      expect(
        (yield* observeEnvRow(c1.project.projectId, c1.env.envId)).value,
      ).toEqual("cohab-v2");
      expect(c5.hook.webhookId).toEqual(c4.hook.webhookId);
      expect(c5.hook.secret).toEqual(c4.hook.secret);

      const depsAfter5 = yield* liveDeployments(c1.project.projectId);
      const depIdsAfter5 = depsAfter5.map((d) => d.uid).sort();
      // The complementary target inference: a production deployment now
      // exists (cycle 1's auto-promoted one), so this no-target redeploy
      // landed as a true PREVIEW deployment. Both live: the platform never
      // demotes, alchemy never deletes what it can re-point around.
      expect(depsAfter5).toHaveLength(2);
      const dep5 = depsAfter5.find((d) => d.uid === c5.tenant.deploymentId);
      expect(dep5).toBeDefined();
      expect(dep5!.target ?? null).toBeNull();

      // ═══ CYCLE 6: the §5.1 conflict — tenant env key shadowed by the
      //     sibling ProjectEnv row (project env WINS on conflict) ════════
      const conflicted = yield* Effect.result(
        stack.deploy(full({ ...v5, tenantKey: ENV_KEY })),
      );
      expect(Result.isFailure(conflicted)).toBe(true);
      const conflictText = Result.isFailure(conflicted)
        ? describeFailure(conflicted.failure)
        : "";
      expect(
        conflictText.includes("TenantEnvConflict") ||
          conflictText.includes("already exist in shared project"),
      ).toBe(true);
      expect(conflictText).toContain(ENV_KEY);

      // The conflict fired BEFORE any deploy: no new deployment appeared
      // and the alias still serves cycle-5 content.
      const depsAfterConflict = yield* liveDeployments(c1.project.projectId);
      expect(depsAfterConflict.map((d) => d.uid).sort()).toEqual(depIdsAfter5);
      yield* pollGreeting(`${c5.tenant.url}/env`, bypass, "greet-v2");
      // Siblings untouched by the failed deploy.
      expect((yield* observeFirewall(c1.project.projectId))!.version).toEqual(
        c2.waf.version,
      );
      expect(yield* observeHook(c4.hook.webhookId)).toBeDefined();

      // Recovery: redeploying the good shape is a pure skip-on-hash noop.
      const recovered = yield* stack.deploy(full(v5));
      expect(recovered.tenant.deploymentId).toEqual(c5.tenant.deploymentId);
      expect(recovered.hook.webhookId).toEqual(c4.hook.webhookId);

      // ═══ CYCLE 7: tenant removal ONLY — surgical destroy ═════════════
      const c7 = yield* stack.deploy(siblings(v5));
      expect(c7.project.projectId).toEqual(c1.project.projectId);

      // The tenant's stage alias and meta-stamped deployments drain…
      expect(yield* observeAlias(c1.tenant.stageAlias!.alias)).toBeUndefined();
      const tenantGone = yield* liveDeployments(c1.project.projectId).pipe(
        Effect.map((deps) => deps.length === 0),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
      expect(tenantGone).toBe(true);
      // …while the shared project and every sibling survive, unchanged.
      expect(yield* observeProject(c1.project.projectId)).toBeDefined();
      const env7 = yield* observeEnvRow(c1.project.projectId, c1.env.envId);
      expect(env7.value).toEqual("cohab-v2");
      const waf7 = yield* observeFirewall(c1.project.projectId);
      expect(waf7!.firewallEnabled).toEqual(true);
      expect(waf7!.rules).toHaveLength(1);
      expect(waf7!.version).toEqual(c2.waf.version);
      expect(yield* observeHook(c4.hook.webhookId)).toBeDefined();

      // ═══ CYCLE 8: full destroy — census clean ════════════════════════
      yield* stack.destroy();
      yield* expectProjectGone(c1.project.projectId);
      expect(yield* observeHook(c4.hook.webhookId)).toBeUndefined();

      // Idempotent double-destroy.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
