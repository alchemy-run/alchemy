import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { PERSONAL, TEST_ORG } from "./fixtures/org.ts";

// The testing account's plan is the organization's, so the cases that start
// a sandbox run there, and the personal ones stop at the environment.
const { test } = Test.make({ providers: Boat.providers({ org: PERSONAL }) });
const team = Test.make({ providers: Boat.providers({ org: TEST_ORG }) });

const tags = ["provider:boat", "provider:boat:credential-profile", "live"];

const profiles = boat.listCredentialProfiles({}).pipe(Effect.map((r) => r.profiles));

const observe = (credentialProfileId: string) =>
  profiles.pipe(Effect.map((all) => all.find((profile) => profile.id === credentialProfileId)));

// `/environments` routes take the org as a query, and ignore the stack's.
const environmentOf = (environmentId: string, org?: string) =>
  boat
    .listEnvironments(org ? { org } : {})
    .pipe(
      Effect.map((r) => r.environments.find((environment) => environment.id === environmentId)),
    );

// Boat stores whatever it is given, so none of these is a real key.
const API = "ALCHEMY_TEST_API";

team.test.provider(
  "create a profile, change its keys and custom APIs in place, rename it, and hand it to a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (props: {
        step: string;
        anthropic: string;
        openai?: string;
        api?: { key: string; baseUrl: string };
        name?: string;
      }) =>
        Effect.gen(function* () {
          const AgentAi = Boat.CredentialProfile("AgentAi", {
            name: props.name,
            anthropic: Redacted.make(props.anthropic),
            openai: props.openai === undefined ? undefined : Redacted.make(props.openai),
            apis:
              props.api === undefined
                ? undefined
                : { [API]: { key: Redacted.make(props.api.key), baseUrl: props.api.baseUrl } },
          });
          const Agents = Boat.Environment("Agents", { credentialProfile: AgentAi });
          // A new `env` replaces the sandbox, so each step starts a fresh one.
          const box = yield* Boat.Sandbox("OnAgents", {
            type: "small",
            autoStop: "10 minutes",
            environment: Agents,
            env: { STEP: props.step },
          });
          return { profile: yield* AgentAi, environment: yield* Agents, box };
        });

      const printed = (sandboxId: string) =>
        boat
          .executeSandboxCommand({
            sandboxId,
            command: `echo "$ANTHROPIC_API_KEY|$OPENAI_API_KEY|$${API}|$${API}_BASE_URL"`,
          })
          .pipe(Effect.map((ran) => ("stdout" in ran ? ran.stdout.trim() : undefined)));

      const first = {
        step: "one",
        anthropic: "sk-ant-alchemy-test-1",
        api: { key: "api-secret-1", baseUrl: "https://api.example.com/v1" },
      };
      const { profile, environment, box } = yield* stack.deploy(program(first));
      expect(profile.org).toBe(TEST_ORG);
      expect(profile.isDefault).toBe(false);
      const created = yield* observe(profile.credentialProfileId);
      expect(created?.name).toBe(profile.name);
      expect(created?.owner.kind).toBe("org");
      expect(created?.owner.name.toLowerCase()).toBe(TEST_ORG.toLowerCase());
      expect(created?.connected).toEqual(["anthropic-api-key"]);
      expect(created?.customApis).toEqual([API]);

      // The environment names it and passes it, and nothing else of the account's.
      const onProfile = yield* environmentOf(environment.environmentId, TEST_ORG);
      expect(onProfile?.credentialProfileId).toBe(profile.credentialProfileId);
      expect(onProfile?.passAgentsCredentials).toBe(true);
      expect(onProfile?.passGithub).toBe(false);
      expect(onProfile?.passSandboxCredentials).toBe(false);
      expect(yield* printed(box.sandboxId)).toBe(
        "sk-ant-alchemy-test-1||api-secret-1|https://api.example.com/v1",
      );

      // Boat never returns a key, so an unchanged redeploy writes none.
      const plan = yield* stack.plan(program(first));
      expect(plan.resources.AgentAi.action).toBe("noop");
      expect(plan.resources.Agents.action).toBe("noop");
      yield* stack.deploy(program(first));
      expect((yield* observe(profile.credentialProfileId))?.updatedAt).toBe(created?.updatedAt);

      // A new key value, a key added and a custom API moved, in place.
      const second = {
        step: "two",
        anthropic: "sk-ant-alchemy-test-2",
        openai: "sk-openai-alchemy-test",
        api: { key: "api-secret-1", baseUrl: "https://api.example.org/v2" },
      };
      const changed = yield* stack.deploy(program(second));
      expect(changed.profile.credentialProfileId).toBe(profile.credentialProfileId);
      expect([...changed.profile.connected].sort()).toEqual([
        "anthropic-api-key",
        "openai-api-key",
      ]);
      expect(yield* printed(changed.box.sandboxId)).toBe(
        "sk-ant-alchemy-test-2|sk-openai-alchemy-test|api-secret-1|https://api.example.org/v2",
      );

      // What the props no longer list is removed, and the name changes in place.
      const name = `alchemy-renamed-${stack.stage}`.toLowerCase().replaceAll("_", "-");
      const third = { step: "three", anthropic: "sk-ant-alchemy-test-2", name };
      const trimmed = yield* stack.deploy(program(third));
      expect(trimmed.profile.credentialProfileId).toBe(profile.credentialProfileId);
      const observed = yield* observe(profile.credentialProfileId);
      expect(observed?.name).toBe(name);
      expect(observed?.connected).toEqual(["anthropic-api-key"]);
      expect(observed?.customApis).toEqual([]);
      expect(yield* printed(trimmed.box.sandboxId)).toBe("sk-ant-alchemy-test-2|||");

      // The environment goes first: Boat refuses to delete a profile in use.
      yield* stack.destroy();
      expect(yield* observe(profile.credentialProfileId)).toBeUndefined();
      expect(yield* environmentOf(environment.environmentId, TEST_ORG)).toBeUndefined();
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "without an org, the profile is yours and your own environment can name it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const MyAi = Boat.CredentialProfile("MyAi", {
          anthropic: Redacted.make("sk-ant-alchemy-mine"),
        });
        const Mine = Boat.Environment("MineAi", { credentialProfile: MyAi });
        return { profile: yield* MyAi, environment: yield* Mine };
      });

      const { profile, environment } = yield* stack.deploy(program);
      expect(profile.org).toBeUndefined();
      const created = yield* observe(profile.credentialProfileId);
      expect(created?.owner.kind).toBe("personal");
      expect(created?.connected).toEqual(["anthropic-api-key"]);
      expect((yield* environmentOf(environment.environmentId))?.credentialProfileId).toBe(
        profile.credentialProfileId,
      );
      expect(yield* environmentOf(environment.environmentId, TEST_ORG)).toBeUndefined();

      // Read finds it again among yours, so an unchanged redeploy plans nothing.
      const plan = yield* stack.plan(program);
      expect(plan.resources.MyAi.action).toBe("noop");
      expect(plan.resources.MineAi.action).toBe("noop");

      yield* stack.destroy();
      expect(yield* observe(profile.credentialProfileId)).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "look up the default profile and name it on an environment, without managing it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const standing = (yield* profiles).find(
        (profile) => profile.owner.kind === "personal" && profile.isDefault,
      );
      expect(standing).toBeDefined();

      const program = Effect.gen(function* () {
        const Default = Boat.CredentialProfile.lookup({ name: "default" });
        const environment = yield* Boat.Environment("OnDefault", { credentialProfile: Default });
        return { credentialProfileId: Default.credentialProfileId, environment };
      });

      const { credentialProfileId, environment } = yield* stack.deploy(program);
      expect(credentialProfileId).toBe(standing?.id);
      const observed = yield* environmentOf(environment.environmentId);
      expect(observed?.credentialProfileId).toBe(standing?.id);
      expect(observed?.passAgentsCredentials).toBe(true);

      const plan = yield* stack.plan(program);
      expect(plan.resources.OnDefault.action).toBe("noop");

      // Destroying the stack leaves the profile it only referenced.
      yield* stack.destroy();
      expect(yield* environmentOf(environment.environmentId)).toBeUndefined();
      expect((yield* observe(credentialProfileId))?.isDefault).toBe(true);
    }),
  { tags, timeout: 180_000 },
);
