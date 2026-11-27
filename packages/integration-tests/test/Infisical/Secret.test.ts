import { createHash } from "node:crypto";
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
import { testProject } from "./project.ts";

const { test } = Test.make({ providers: Infisical.providers() });

describe("Secret", { tags: ["provider:infisical", "provider:infisical:secret", "live"] }, () => {
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
        expect(valueOf(created)).toBe("Authorization=initial");
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
        expect(valueOf(rotatedRow)).toBe("rotated");
        expect(rotatedRow.secretComment).toBe("Token");

        // A value changed outside the stack is written again on the next deploy.
        yield* infisical.updateSecretV4({
          projectId: props.project,
          environment: props.environment,
          secretName: props.name,
          type: "shared",
          secretValue: "drifted",
        });
        yield* stack.deploy(program({ value: Redacted.make("rotated"), comment: "Token" }));
        expect(valueOf(yield* get(props))).toBe("rotated");

        // A create whose attributes never reached state: deploy finds the
        // row by its key and keeps it.
        yield* forgetAttributes(stack);
        const recovered = yield* stack.deploy(
          program({ value: Redacted.make("rotated"), comment: "Token" }),
        );
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
        expect(valueOf(owned)).toBe("Authorization=initial");
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

  test.provider(
    "replaces on a key change, recreates a row deleted by hand, and refuses one made in its place",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const props = yield* declaration(stack);
        const renamed = { ...props, name: `${props.name}_RENAMED` };
        const first = yield* stack.deploy(Infisical.Secret("Secret", props));

        // A new key replaces the secret: the new row is written, the old one deleted.
        const replaced = yield* stack.deploy(Infisical.Secret("Secret", renamed));
        expect(replaced.id).not.toBe(first.id);
        expect(replaced.name).toBe(renamed.name);
        expect(valueOf(yield* get(renamed))).toBe("Authorization=initial");
        expect(yield* find(props)).toBeUndefined();

        // A row deleted outside the stack is written again.
        yield* removeByHand(renamed);
        const recreated = yield* stack.deploy(Infisical.Secret("Secret", renamed));
        expect(recreated.id).not.toBe(replaced.id);
        expect(valueOf(yield* get(renamed))).toBe("Authorization=initial");

        // A row made by hand in its place is not taken over, nor deleted.
        yield* removeByHand(renamed);
        yield* infisical.createSecretV4({
          projectId: renamed.project,
          environment: renamed.environment,
          secretName: renamed.name,
          type: "shared",
          secretValue: "Handmade value",
        });
        const refused = yield* Effect.exit(stack.deploy(Infisical.Secret("Secret", renamed)));
        assert(Exit.isFailure(refused), "A row made by hand in the stack's place was taken over");
        expect(Option.getOrThrow(Cause.findErrorOption(refused.cause))).toBeInstanceOf(
          Infisical.SecretNotOwned,
        );
        expect(valueOf(yield* get(renamed))).toBe("Handmade value");

        yield* stack.destroy();
        expect(valueOf(yield* get(renamed))).toBe("Handmade value");
        yield* removeByHand(renamed);
      }),
    { timeout: 120_000 },
  );
});

const declaration = Effect.fn(function* (stack: Test.ScratchStack) {
  return {
    project: yield* testProject,
    environment: yield* Config.String("INFISICAL_TEST_ENVIRONMENT").pipe(Config.withDefault("dev")),
    // Infisical caps the key's length in the URL, so hash the stack and stage
    // into a short key that stays unique per test, user and worktree.
    name: `ALCHEMY_TEST_${yield* Effect.sync(() =>
      createHash("sha256")
        .update(`${stack.name}/${stack.stage}`)
        .digest("hex")
        .slice(0, 16)
        .toUpperCase(),
    )}`,
    value: Redacted.make("Authorization=initial"),
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

const removeByHand = (props: Infisical.SecretProps) =>
  infisical.deleteSecretV4({
    projectId: props.project,
    environment: props.environment,
    secretPath: props.path ?? "/",
    secretName: props.name,
    type: "shared",
  });

const find = (props: Infisical.SecretProps) =>
  get(props).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Distilled returns the stored value as a `Redacted`. */
const valueOf = ({ secretValue }: infisical.GetSecretByNameV4ResponseSecret) =>
  Redacted.isRedacted(secretValue) ? Redacted.value(secretValue) : secretValue;

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
