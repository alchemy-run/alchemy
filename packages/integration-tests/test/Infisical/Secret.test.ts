import * as Infisical from "@alchemy.run/infisical";
import { assert, describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as infisical from "@distilled.cloud/infisical";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { isActionState, State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Infisical.providers() });

// Runs against an existing project, given by its UUID; the environment slug
// defaults to the project's standard development environment.
describe.skipIf(!process.env.INFISICAL_TEST || !process.env.INFISICAL_TEST_PROJECT)(
  "Secret",
  { tags: ["provider:infisical", "provider:infisical:secret", "live"] },
  () => {
    test.provider(
      "writes, updates, repairs, recovers and deletes a shared secret",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const props = yield* declaration(stack);
          const program = (changes: Partial<Infisical.SecretProps> = {}) =>
            Infisical.Secret("Secret", { ...props, ...changes });

          const first = yield* stack.deploy(program());
          const created = yield* get(props);
          expect(first).toEqual({
            id: created.id,
            project: props.project,
            environment: props.environment,
            path: "/",
            name: props.name,
            comment: "",
            version: created.version,
          });
          expect(created.secretValue).toBe(props.value);
          expect(metadata(created)).toEqual({
            "alchemy::stack": stack.name,
            "alchemy::stage": stack.stage,
            "alchemy::id": "Secret",
            "alchemy::instance": expect.any(String),
          });

          const unchanged = yield* stack.deploy(program());
          expect(unchanged.id).toBe(first.id);
          expect((yield* get(props)).version).toBe(created.version);

          const rotated = yield* stack.deploy(
            program({ value: Redacted.make("rotated"), comment: "Token" }),
          );
          expect(rotated.id).toBe(first.id);
          const rotatedRow = yield* get(props);
          expect(rotatedRow.secretValue).toBe("rotated");
          expect(rotatedRow.secretComment).toBe("Token");

          // A value changed outside the stack is written again on the next deploy.
          yield* infisical.updateSecretV4({
            projectId: props.project,
            environment: props.environment,
            secretName: props.name,
            type: "shared",
            secretValue: "drifted",
          });
          yield* stack.deploy(program({ value: "rotated", comment: "Token" }));
          expect((yield* get(props)).secretValue).toBe("rotated");

          // A create whose attributes never reached state: deploy finds the
          // row by its key and keeps it.
          yield* forgetAttributes(stack);
          const recovered = yield* stack.deploy(program({ value: "rotated", comment: "Token" }));
          expect(recovered.id).toBe(first.id);

          yield* stack.destroy();
          expect(yield* find(props)).toBeUndefined();
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "adopts a shared secret made by hand only with --adopt, keeping its metadata",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const props = yield* declaration(stack);
          yield* infisical.createSecretV4({
            projectId: props.project,
            environment: props.environment,
            secretName: props.name,
            type: "shared",
            secretValue: "Handmade value",
            secretMetadata: [{ key: "managed-by", value: "test-fixture" }],
          });
          const original = yield* get(props);
          const program = Infisical.Secret("Secret", props);

          const refused = yield* Effect.exit(stack.deploy(program));
          assert(Exit.isFailure(refused), "A shared secret made by hand was taken without --adopt");
          expect(Option.getOrThrow(Cause.findErrorOption(refused.cause))).toBeInstanceOf(
            OwnedBySomeoneElse,
          );
          expect(yield* get(props)).toEqual(original);

          const adopted = yield* stack.deploy(program).pipe(adopt(true));
          expect(adopted.id).toBe(original.id);
          const owned = yield* get(props);
          expect(owned.secretValue).toBe(props.value);
          expect(metadata(owned)).toEqual({
            "managed-by": "test-fixture",
            "alchemy::stack": stack.name,
            "alchemy::stage": stack.stage,
            "alchemy::id": "Secret",
            "alchemy::instance": expect.any(String),
          });

          yield* stack.destroy();
          expect(yield* find(props)).toBeUndefined();
        }),
      { timeout: 120_000 },
    );
  },
);

const declaration = Effect.fn(function* (stack: Test.ScratchStack) {
  return {
    project: yield* Config.String("INFISICAL_TEST_PROJECT"),
    environment: yield* Config.String("INFISICAL_TEST_ENVIRONMENT").pipe(Config.withDefault("dev")),
    name: `ALCHEMY_${stack.name}_${stack.stage}`.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase(),
    value: "Authorization=initial",
  };
});

const get = (props: Infisical.SecretProps) =>
  infisical
    .getSecretByNameV4({
      projectId: props.project,
      environment: props.environment,
      secretName: props.name,
      secretPath: props.path ?? "/",
      type: "shared",
      viewSecretValue: true,
      expandSecretReferences: false,
      includeImports: false,
    })
    .pipe(Effect.map(({ secret }) => secret));

const find = (props: Infisical.SecretProps) =>
  get(props).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const metadata = (secret: infisical.GetSecretByNameV4ResponseSecret) =>
  Object.fromEntries((secret.secretMetadata ?? []).map(({ key, value }) => [key, value]));

/**
 * Reproduce a create whose response or state write was lost: the secret
 * exists in Infisical, but its row is still `creating`, with no attributes.
 */
const forgetAttributes = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn: "Secret" };
    const stored = yield* state.get(address);
    if (
      !stored ||
      isActionState(stored) ||
      (stored.status !== "created" && stored.status !== "updated")
    ) {
      return yield* Effect.die(new Error("Expected a deployed Secret row"));
    }
    const { attr: _, ...rest } = stored;
    yield* state.set({ ...address, value: { ...rest, status: "creating" } });
  }).pipe(Effect.provide(stack.state));
