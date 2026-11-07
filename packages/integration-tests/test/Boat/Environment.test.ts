import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:environment", "live"];

const observe = (environmentId: string) =>
  boat
    .listEnvironments({})
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
          const environment = yield* Boat.Environment("Agents", {
            env: { MODE: "agent", TOKEN: Redacted.make(props.token), QUOTED: 'a b "c"' },
            secretFiles: [{ path: "~/.alchemy-test", contents: Redacted.make("file-secret") }],
            passGithub: false,
            safeForThirdParties: props.safe,
          });
          const box = yield* Boat.Sandbox("OnAgents", {
            type: "small",
            ttlSeconds: 600,
            environment: environment.name,
          });
          return { environment, box };
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
