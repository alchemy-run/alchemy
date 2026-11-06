import * as Infisical from "@alchemy.run/infisical";
import { assert, describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as infisical from "@distilled.cloud/infisical";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Infisical.providers() });

const metadata = (secret: infisical.GetSecretByNameV4ResponseSecret) =>
  Object.fromEntries((secret.secretMetadata ?? []).map(({ key, value }) => [key, value]));

const get = (props: Infisical.SecretProps, type: "shared" | "personal" = "shared") =>
  infisical
    .getSecretByNameV4({
      projectId: props.project,
      environment: props.environment,
      secretName: props.name,
      secretPath: props.path ?? "/",
      type,
      viewSecretValue: true,
      expandSecretReferences: false,
      includeImports: false,
    })
    .pipe(Effect.map(({ secret }) => secret));

const remove = (props: Infisical.SecretProps, type: "shared" | "personal" = "shared") =>
  infisical
    .deleteSecretV4({
      projectId: props.project,
      environment: props.environment,
      secretName: props.name,
      secretPath: props.path ?? "/",
      type,
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.asVoid,
    );

const declaration = Effect.fn(function* (stack: Test.ScratchStack) {
  return {
    project: yield* Config.String("INFISICAL_TEST_PROJECT"),
    environment: yield* Config.String("INFISICAL_TEST_ENVIRONMENT").pipe(Config.withDefault("dev")),
    name: `ALCHEMY_${stack.name}_${stack.stage}`.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase(),
    value: "Authorization=initial",
  };
});

// Personal overrides require a user-authenticated test profile. The optional
// environment slug defaults to the project's standard development environment.
describe.skipIf(!process.env.INFISICAL_TEST || !process.env.INFISICAL_TEST_PROJECT)(
  "Secret",
  { tags: ["live", "provider:infisical", "provider:infisical:secret"] },
  () => {
    test.provider(
      "converges a shared row, repairs drift, and preserves a personal override",
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
          expect(created.type).toBe("shared");
          expect(metadata(created)).toEqual({
            "alchemy::stack": stack.name,
            "alchemy::stage": stack.stage,
            "alchemy::id": "Secret",
            "alchemy::instance": expect.any(String),
          });

          yield* Effect.acquireUseRelease(
            infisical.createSecretV4({
              projectId: props.project,
              environment: props.environment,
              secretName: props.name,
              type: "personal",
              secretValue: "Authorization=personal",
              secretComment: "Personal override",
            }),
            () =>
              Effect.gen(function* () {
                const personal = yield* get(props, "personal");
                const unchanged = yield* stack.deploy(program());
                expect(unchanged.id).toBe(first.id);
                expect((yield* get(props)).version).toBe(created.version);

                const rotated = yield* stack.deploy(program({ value: Redacted.make("rotated") }));
                expect(rotated.id).toBe(first.id);
                const rotatedRow = yield* get(props);
                expect(rotatedRow.secretValue).toBe("rotated");
                expect(rotatedRow.secretComment).toBe("");
                expect(rotatedRow.version).toBe(created.version + 1);

                const commented = yield* stack.deploy(
                  program({ value: "rotated", comment: "Token" }),
                );
                expect(commented.id).toBe(first.id);
                const commentedRow = yield* get(props);
                expect(commentedRow.secretValue).toBe("rotated");
                expect(commentedRow.secretComment).toBe("Token");
                expect(commentedRow.version).toBe(rotatedRow.version + 1);

                yield* infisical.updateSecretV4({
                  projectId: props.project,
                  environment: props.environment,
                  secretName: props.name,
                  type: "shared",
                  secretValue: "drifted",
                  secretComment: "Drifted comment",
                });
                expect((yield* get(props)).secretValue).toBe("drifted");
                const repaired = yield* stack.deploy(
                  program({ value: "rotated", comment: "Token" }),
                );
                expect(repaired.id).toBe(first.id);
                const repairedRow = yield* get(props);
                expect(repairedRow.secretValue).toBe("rotated");
                expect(repairedRow.secretComment).toBe("Token");
                expect(metadata(repairedRow)).toEqual(metadata(created));
                expect(yield* get(props, "personal")).toEqual(personal);

                const cleared = yield* stack.deploy(program({ value: "rotated" }));
                expect(cleared.id).toBe(first.id);
                const clearedRow = yield* get(props);
                expect(clearedRow.secretComment).toBe("");
                expect(clearedRow.secretValue).toBe("rotated");

                yield* stack.destroy();
                expect(
                  yield* get(props).pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
                ).toBeUndefined();
                expect(yield* get(props, "personal")).toEqual(personal);
              }),
            () => remove(props, "personal"),
          );
          yield* stack.destroy();
        }).pipe(infisical.Retry.none),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "requires adoption of a foreign shared row and preserves its metadata",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const props = yield* declaration(stack);
          yield* Effect.acquireUseRelease(
            infisical.createSecretV4({
              projectId: props.project,
              environment: props.environment,
              secretName: props.name,
              type: "shared",
              secretValue: "Handmade value",
              secretComment: "Handmade comment",
              secretMetadata: [{ key: "managed-by", value: "test-fixture" }],
            }),
            () =>
              Effect.gen(function* () {
                const original = yield* get(props);
                const program = () => Infisical.Secret("Secret", props);
                const refused = yield* Effect.exit(stack.deploy(program()));
                assert(Exit.isFailure(refused), "An unowned shared secret was accepted");
                expect(Option.getOrThrow(Cause.findErrorOption(refused.cause))).toBeInstanceOf(
                  OwnedBySomeoneElse,
                );
                expect(yield* get(props)).toEqual(original);

                const adopted = yield* stack.deploy(program()).pipe(adopt(true));
                expect(adopted.id).toBe(original.id);
                const owned = yield* get(props);
                expect(owned.secretValue).toBe(props.value);
                expect(owned.secretComment).toBe("");
                expect(metadata(owned)).toEqual({
                  "managed-by": "test-fixture",
                  "alchemy::stack": stack.name,
                  "alchemy::stage": stack.stage,
                  "alchemy::id": "Secret",
                  "alchemy::instance": expect.any(String),
                });
                yield* stack.destroy();
                expect(
                  yield* get(props).pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
                ).toBeUndefined();
              }),
            () => remove(props),
          );
          yield* stack.destroy();
        }).pipe(infisical.Retry.none),
      { timeout: 120_000, retry: 0 },
    );
  },
);
