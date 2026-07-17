import * as AWS from "@/AWS";
import { PublicKey } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvTkfqkMHU8HMmIRKJaMl
IoD691g60aS15QlaP/DVkpuoeEp8JA8YDs5vQFu6HSIYCTQ7WwFx9oRvN08i7yXB
EHt3x7uZVpdkp6JBbjR9BGNsAVri6DZ0TJQ11zWeN3keqhnUdFhQjPwT+u4r6oKk
kNvkl7eU2nFK+UIaPlD+rA+AlYT0m7gSVcd9KaLf/UzBrtSy1dbXYDT4dHChMUVy
4gDsQ6D4u6lRAHY9jcKxlgEIM+O8ODKyzlbergv2EwhANG4P27DBeDhA/off3upM
TTVTGKZeoABtqM0ZiYq0cDgf8KUn9NPxSdnJ4+cbigLjJBPS93VYWzWX0HXlZpQ3
HQIDAQAB
-----END PUBLIC KEY-----
`;

describe("AWS.CloudFront.PublicKey", () => {
  test.provider.skipIf(!runLive)(
    "create, update comment, and delete a public key",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* PublicKey("SignedUrlKey", {
              encodedKey: TEST_PUBLIC_KEY,
              comment: "initial",
            });
          }),
        );

        const initial = yield* cloudfront.getPublicKey({
          Id: created.publicKeyId,
        });
        expect(initial.PublicKey?.Id).toEqual(created.publicKeyId);
        expect(initial.PublicKey?.PublicKeyConfig?.Comment).toEqual("initial");
        // CloudFront normalizes the stored key (trailing newline stripped).
        expect(initial.PublicKey?.PublicKeyConfig?.EncodedKey?.trim()).toEqual(
          TEST_PUBLIC_KEY.trim(),
        );

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* PublicKey("SignedUrlKey", {
              encodedKey: TEST_PUBLIC_KEY,
              comment: "updated",
            });
          }),
        );

        expect(updated.publicKeyId).toEqual(created.publicKeyId);
        expect(updated.callerReference).toEqual(created.callerReference);

        const after = yield* cloudfront.getPublicKey({
          Id: updated.publicKeyId,
        });
        expect(after.PublicKey?.PublicKeyConfig?.Comment).toEqual("updated");

        yield* stack.destroy();
        yield* assertPublicKeyDeleted(updated.publicKeyId);
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!runLive)(
    "list enumerates the deployed public key",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* PublicKey("ListResource", {
              encodedKey: TEST_PUBLIC_KEY,
              comment: "list test",
            });
          }),
        );

        const provider = yield* Provider.findProvider(PublicKey);
        const all = yield* provider.list();

        expect(all.some((x) => x.publicKeyId === deployed.publicKeyId)).toBe(
          true,
        );

        yield* stack.destroy();
        yield* assertPublicKeyDeleted(deployed.publicKeyId);
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!runLive)(
    "recovers a wedged creating-state row that lost its Output-valued encodedKey (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployKey = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* PublicKey("WedgedKey", {
                encodedKey: TEST_PUBLIC_KEY,
                comment: "wedged recovery test",
              });
            }),
          );

        const created = yield* deployKey();

        // Rewrite the persisted row into the wedged shape an interrupted
        // deploy leaves behind: `creating`, no attributes, and the
        // Output-valued `encodedKey` lost in the round-trip (#736).
        const state = yield* yield* State;
        const stage = "test"; // scratch stacks default to the "test" stage
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state
            .get({ stack: stack.name, stage, fqn })
            .pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "AWS.CloudFront.PublicKey",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error(
              "no AWS.CloudFront.PublicKey state row found after deploy",
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
            props: {
              ...wedged.row.props,
              encodedKey: undefined,
            },
          },
        });

        // Delete the public key out-of-band so the recovery `read` misses
        // and the engine falls through to `diff` with the junk olds.
        const current = yield* cloudfront.getPublicKey({
          Id: created.publicKeyId,
        });
        yield* cloudfront
          .deletePublicKey({
            Id: created.publicKeyId,
            IfMatch: current.ETag,
          })
          .pipe(Effect.catchTag("NoSuchPublicKey", () => Effect.void));
        yield* assertPublicKeyDeleted(created.publicKeyId);

        // Before the fix this crashed in `diff`: `extractValue(undefined)`
        // called `Redacted.value(undefined)` on the lost `olds.encodedKey`.
        // After the fix, diff skips the comparison and the engine recreates
        // the key cleanly.
        const recovered = yield* deployKey();
        expect(recovered.publicKeyId).not.toEqual(created.publicKeyId);

        const after = yield* cloudfront.getPublicKey({
          Id: recovered.publicKeyId,
        });
        expect(after.PublicKey?.Id).toEqual(recovered.publicKeyId);
        // CloudFront normalizes the stored key (trailing newline stripped).
        expect(after.PublicKey?.PublicKeyConfig?.EncodedKey?.trim()).toEqual(
          TEST_PUBLIC_KEY.trim(),
        );

        yield* stack.destroy();
        yield* assertPublicKeyDeleted(recovered.publicKeyId);
      }),
    { timeout: 240_000 },
  );
});

const assertPublicKeyDeleted = (id: string) =>
  cloudfront.getPublicKey({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("PublicKeyStillExists"))),
    Effect.catchTag("NoSuchPublicKey", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "PublicKeyStillExists",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
