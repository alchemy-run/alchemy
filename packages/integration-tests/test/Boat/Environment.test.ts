import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { TEST_ORG } from "./fixtures/org.ts";

const { test } = Test.make({ providers: Boat.providers() });
const team = Test.make({ providers: Boat.providers({ org: TEST_ORG }) });

const tags = ["provider:boat", "provider:boat:environment", "live"];

const observe = (environmentId: string, org?: string) =>
  boat
    .listEnvironments(org ? { org } : {})
    .pipe(
      Effect.map((r) => r.environments.find((environment) => environment.id === environmentId)),
    );

test.provider(
  "create an environment, update its variables and flags in place, and start a sandbox on it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (props: { token: string; safe: boolean }) =>
        Effect.gen(function* () {
          const Agents = Boat.Environment("Agents", {
            env: { MODE: "agent", TOKEN: Redacted.make(props.token), QUOTED: 'a b "c"' },
            secretFiles: [{ path: "~/.alchemy-test", contents: Redacted.make("file-secret") }],
            passGithub: false,
            safeForThirdParties: props.safe,
          });
          const box = yield* Boat.Sandbox("OnAgents", {
            type: "small",
            autoStop: "10 minutes",
            environment: Agents,
          });
          return { environment: yield* Agents, box };
        });

      const { environment, box } = yield* stack.deploy(program({ token: "t1", safe: false }));
      const created = yield* observe(environment.environmentId);
      expect(created?.name).toBe(environment.name);
      expect(created?.passGithub).toBe(false);
      expect(created?.secretFiles.map((file) => file.path)).toEqual([".alchemy-test"]);
      expect(box.environment).toBe(environment.name);
      const vars = yield* boat.executeSandboxCommand({
        sandboxId: box.sandboxId,
        command: 'echo "$MODE|$TOKEN|$QUOTED"; cat ~/.alchemy-test',
      });
      expect("stdout" in vars ? vars.stdout : undefined).toBe('agent|t1|a b "c"\nfile-secret');

      // An unchanged redeploy plans nothing and mints no version.
      const plan = yield* stack.plan(program({ token: "t1", safe: false }));
      expect(plan.resources.Agents.action).toBe("noop");
      const again = yield* stack.deploy(program({ token: "t1", safe: false }));
      expect(again.environment.latestVersionNumber).toBe(environment.latestVersionNumber);

      // Variables and flags change in place, as a new version.
      const updated = yield* stack.deploy(program({ token: "t2", safe: true }));
      expect(updated.environment.environmentId).toBe(environment.environmentId);
      expect(updated.environment.latestVersionNumber).toBeGreaterThan(
        environment.latestVersionNumber,
      );
      const observed = yield* observe(environment.environmentId);
      expect(observed?.safeForThirdParties).toBe(true);
      expect(observed?.envContents).toContain("TOKEN=t2");

      yield* stack.destroy();
      expect(yield* observe(environment.environmentId)).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);

team.test.provider(
  "with an org, the environment is the org's shared one and its sandboxes bill the org",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const Shared = Boat.Environment("Shared", { env: { SCOPE: "team" } });
        const box = yield* Boat.Sandbox("OnShared", {
          type: "small",
          autoStop: "10 minutes",
          environment: Shared,
        });
        return { environment: yield* Shared, box };
      });

      const { environment, box } = yield* stack.deploy(program);
      // `/environments` routes ignore `X-Boat-Org`: only the `org` query
      // reaches the org's environments, and without it the personal ones.
      expect((yield* observe(environment.environmentId, TEST_ORG))?.name).toBe(environment.name);
      expect(yield* observe(environment.environmentId)).toBeUndefined();

      const sandbox = yield* boat.getSandbox({ sandboxId: box.sandboxId });
      expect(sandbox.sandbox.team?.name.toLowerCase()).toBe(TEST_ORG.toLowerCase());
      const vars = yield* boat.executeSandboxCommand({
        sandboxId: box.sandboxId,
        command: 'echo "$SCOPE"',
      });
      expect("stdout" in vars ? vars.stdout : undefined).toBe("team\n");

      // Read finds it again in the org, so an unchanged redeploy plans nothing.
      const plan = yield* stack.plan(program);
      expect(plan.resources.Shared.action).toBe("noop");

      yield* stack.destroy();
      expect(yield* observe(environment.environmentId, TEST_ORG)).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);
