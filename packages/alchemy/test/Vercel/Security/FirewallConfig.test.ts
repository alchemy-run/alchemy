import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import * as security from "@distilled.cloud/vercel/security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read of the active firewall config via distilled. */
const getActiveConfig = (projectId: string) =>
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

/**
 * Create (or reuse, after an interrupted run) a host project out-of-band via
 * distilled — deterministic name — run `body` against it, and always delete
 * the project again.
 */
const withHostProject = <A, E, R>(
  hostName: string,
  body: (projectId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const host = yield* projects
      .createProject({ name: hostName, ...team })
      .pipe(
        Effect.map((p) => ({ id: p.id })),
        Effect.catchTag("Conflict", () =>
          projects
            .getProject({ idOrName: hostName, ...team })
            .pipe(Effect.map((p) => ({ id: p.id }))),
        ),
      );
    return yield* body(host.id).pipe(
      Effect.ensuring(
        projects
          .deleteProject({ idOrName: host.id, ...team })
          .pipe(Effect.ignore),
      ),
    );
  });

const blockAdminRule = (
  action: Vercel.FirewallRuleAction,
  description?: string,
): Vercel.FirewallRule => ({
  name: "block-admin",
  ...(description !== undefined ? { description } : {}),
  conditionGroup: [
    { conditions: [{ type: "path", op: "pre", value: "/admin" }] },
  ],
  action: { action },
});

test.provider(
  "firewall config lifecycle: put rules, version increments, converge drift, reset on destroy",
  (stack) =>
    withHostProject("alchemy-test-security-fw-life", (projectId) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const props: Vercel.FirewallConfigProps = {
          projectId,
          rules: [blockAdminRule("challenge")],
        };

        const created = yield* stack.deploy(
          Vercel.FirewallConfig("Waf", props),
        );

        expect(created.projectId).toEqual(projectId);
        expect(created.firewallEnabled).toEqual(true);
        expect(created.rules).toHaveLength(1);
        expect(created.rules[0]!.name).toEqual("block-admin");
        expect(created.rules[0]!.active).toEqual(true);
        expect(created.rules[0]!.id.length).toBeGreaterThan(0);
        expect(created.version).toBeGreaterThanOrEqual(1);
        expect(created.ips).toHaveLength(0);

        // Out-of-band verification via distilled.
        const observed = yield* getActiveConfig(projectId);
        expect(observed).toBeDefined();
        expect(observed!.firewallEnabled).toEqual(true);
        expect(observed!.version).toEqual(created.version);
        expect(observed!.rules).toHaveLength(1);
        const observedRule = observed!.rules[0]! as {
          name: string;
          active: boolean;
          action: { mitigate?: { action?: string } };
        };
        expect(observedRule.name).toEqual("block-admin");
        expect(observedRule.action.mitigate?.action).toEqual("challenge");

        // Same props again is a true no-op — version untouched.
        const noop = yield* stack.deploy(Vercel.FirewallConfig("Waf", props));
        expect(noop.version).toEqual(created.version);
        expect(noop.configId).toEqual(created.configId);

        // Drift the config out-of-band: full PUT with an extra rule.
        const team = yield* teamScope;
        yield* security.putFirewallConfig({
          projectId,
          ...team,
          firewallEnabled: true,
          rules: [
            {
              name: "block-admin",
              active: true,
              conditionGroup: [
                { conditions: [{ type: "path", op: "pre", value: "/admin" }] },
              ],
              action: { mitigate: { action: "challenge" } },
            },
            {
              name: "drift-rule",
              active: true,
              conditionGroup: [
                { conditions: [{ type: "path", op: "pre", value: "/drift" }] },
              ],
              action: { mitigate: { action: "deny" } },
            },
          ],
          ips: [],
        });
        const drifted = yield* getActiveConfig(projectId);
        expect(drifted!.rules).toHaveLength(2);
        expect(drifted!.version).toBeGreaterThan(created.version);

        // Reconcile back: deploy the desired document (rule escalated to
        // deny) — the full-replace PUT removes the drift rule.
        const converged = yield* stack.deploy(
          Vercel.FirewallConfig("Waf", {
            projectId,
            rules: [blockAdminRule("deny", "escalated to deny")],
          }),
        );
        expect(converged.rules).toHaveLength(1);
        expect(converged.rules[0]!.name).toEqual("block-admin");
        expect(converged.version).toBeGreaterThan(drifted!.version);

        const afterConverge = yield* getActiveConfig(projectId);
        expect(afterConverge!.rules).toHaveLength(1);
        const convergedRule = afterConverge!.rules[0]! as {
          name: string;
          description?: string;
          action: { mitigate?: { action?: string } };
        };
        expect(convergedRule.name).toEqual("block-admin");
        expect(convergedRule.description).toEqual("escalated to deny");
        expect(convergedRule.action.mitigate?.action).toEqual("deny");

        // Destroy resets the document to empty + disabled (the API's DELETE
        // endpoint targets draft versions, so PUT-empty is the delete
        // primitive — the config document itself remains, versioned).
        yield* stack.destroy();
        const afterDestroy = yield* getActiveConfig(projectId);
        expect(afterDestroy!.firewallEnabled).toEqual(false);
        expect(afterDestroy!.rules).toHaveLength(0);
        expect(afterDestroy!.ips).toHaveLength(0);

        // Destroy again — delete path is idempotent.
        yield* stack.destroy();
      }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing projectId replaces: new project gets the rules, old project is reset",
  (stack) =>
    withHostProject("alchemy-test-security-fw-repl-a", (projectA) =>
      withHostProject("alchemy-test-security-fw-repl-b", (projectB) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const created = yield* stack.deploy(
            Vercel.FirewallConfig("Waf", {
              projectId: projectA,
              rules: [blockAdminRule("deny")],
            }),
          );
          expect(created.projectId).toEqual(projectA);
          expect(created.rules).toHaveLength(1);

          // Re-parenting onto another project is a replacement: the new
          // project's config is written, then the old generation's delete
          // resets project A.
          const replaced = yield* stack.deploy(
            Vercel.FirewallConfig("Waf", {
              projectId: projectB,
              rules: [blockAdminRule("deny")],
            }),
          );
          expect(replaced.projectId).toEqual(projectB);
          expect(replaced.rules).toHaveLength(1);
          expect(replaced.configId).not.toEqual(created.configId);

          const onB = yield* getActiveConfig(projectB);
          expect(onB!.firewallEnabled).toEqual(true);
          expect(onB!.rules).toHaveLength(1);

          const onA = yield* getActiveConfig(projectA);
          expect(onA!.firewallEnabled).toEqual(false);
          expect(onA!.rules).toHaveLength(0);

          yield* stack.destroy();
          const afterDestroy = yield* getActiveConfig(projectB);
          expect(afterDestroy!.firewallEnabled).toEqual(false);
          expect(afterDestroy!.rules).toHaveLength(0);
        }),
      ),
    ).pipe(logLevel),
  { timeout: 120_000 },
);
