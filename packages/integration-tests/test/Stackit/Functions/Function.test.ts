import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { ensureServiceEnabled } from "@alchemy.run/stackit/internal/enable";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as functions from "@distilled.cloud/stackit/functions";
import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { asHarborUser } from "../ContainerRegistry/harbor.ts";
import { logLevel, stackitEnvironment, stackitTags } from "../helpers.ts";
import EffectFunction from "./fixtures/effect-function.ts";
import { Images, Ping } from "./fixtures/stack.ts";
import { EXAMPLE_IMAGE, expectFunctionGone, noBuiltFunctions, noFunctions } from "./helpers.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const options = { tags: stackitTags("functions", "function"), timeout: 900_000 } as const;

/** A revision's variables as plain text: the SDK keeps their values `Redacted`. */
const plainVariables = (revision: functions.Revision) =>
  (revision.variables ?? []).map(({ name, value }) => ({
    name,
    value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
  }));

// Entitlement probe: always runs, on any account. If it fails on an account that
// can't use the alpha API, patch the rejection into a typed tag in distilled, and
// assert that tag here (see "Entitlement gating pattern" in AGENTS.md).
test.provider(
  "the Functions API answers, and one list page holds every function",
  (_stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* ensureServiceEnabled({
        projectId,
        region,
        serviceId: "cloud.stackit.functions",
      });
      const listed = yield* functions.listFunctions({ projectId });
      // `list` can't ask for a second page; see `FunctionsListTruncated`.
      expect(listed.next_page_token ?? "").toEqual("");
    }).pipe(logLevel),
  { tags: stackitTags("functions", "probe"), timeout: 300_000 },
);

test.provider(
  "a mutable image tag fails before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Stackit.Functions.Function("UnpinnedImage", {
            image: "ghcr.io/stackitcloud/example-image:latest",
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "Stackit.Functions.FunctionImageNotPinned" });
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: stackitTags("functions", "function"), timeout: 120_000 },
);

test.provider.skipIf(noFunctions)(
  "removing maxScale rolls out a new revision without it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const fn = (maxScale: number | undefined) =>
        Stackit.Functions.Function("ScaleLimit", { image: EXAMPLE_IMAGE, maxScale });

      const limited = yield* stack.deploy(fn(3));
      const limitedRevision = yield* functions.getRevision({
        projectId,
        functionId: limited.functionId,
        revisionId: limited.revisionId!,
      });
      expect(limitedRevision.limits.max_scale).toEqual(3);

      const unlimited = yield* stack.deploy(fn(undefined));
      expect(unlimited.functionId).toEqual(limited.functionId);
      expect(unlimited.revisionId).not.toEqual(limited.revisionId);

      // The revision now holds the API's default, so nothing is left to roll out.
      const plan = yield* stack.plan(fn(undefined));
      expect(plan.resources.ScaleLimit).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectFunctionGone(projectId, limited.functionId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noFunctions)(
  "a pre-built image: revisions, updates, pruning and delete",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const fn = (props: { greeting: string; name?: string; labels?: Record<string, string> }) =>
        Stackit.Functions.Function("ImageLifecycle", {
          name: props.name,
          image: EXAMPLE_IMAGE,
          env: { GREETING: props.greeting },
          labels: props.labels,
        });

      const created = yield* stack.deploy(fn({ greeting: "one" }));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.state).toEqual("ACTIVE");
      expect(created.image).toEqual(EXAMPLE_IMAGE);
      expect(created.codeHash).toBeUndefined();

      // Out of band: the function serves the revision Alchemy rolled out.
      const fetched = yield* functions.getFunction({
        projectId,
        functionId: created.functionId,
      });
      expect(fetched.current_revision).toEqual(created.revisionId);
      expect(fetched.labels?.["alchemy.id"]).toEqual("ImageLifecycle");

      const revision = yield* functions.getRevision({
        projectId,
        functionId: created.functionId,
        revisionId: created.revisionId!,
      });
      expect(revision.oci_reference).toEqual(EXAMPLE_IMAGE);
      expect(revision.limits).toMatchObject({ plan: "f2", concurrency: 100 });
      // A variable's value is redacted on the way out of the SDK.
      expect(Redacted.isRedacted(revision.variables?.[0]?.value)).toBe(true);
      expect(plainVariables(revision)).toEqual([{ name: "GREETING", value: "one" }]);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(fn({ greeting: "one" }));
      expect(plan.resources.ImageLifecycle).toMatchObject({ action: "noop" });

      // A new variable value is a new revision of the same function.
      const updated = yield* stack.deploy(fn({ greeting: "two" }));
      expect(updated.functionId).toEqual(created.functionId);
      expect(updated.revisionId).not.toEqual(created.revisionId);
      const newer = yield* functions.getRevision({
        projectId,
        functionId: created.functionId,
        revisionId: updated.revisionId!,
      });
      expect(plainVariables(newer)).toEqual([{ name: "GREETING", value: "two" }]);

      // A rename and new labels change the function, not its revision.
      const renamed = yield* stack.deploy(
        fn({ greeting: "two", name: "alchemy-test-renamed", labels: { team: "a" } }),
      );
      expect(renamed.functionId).toEqual(created.functionId);
      expect(renamed.revisionId).toEqual(updated.revisionId);
      expect(renamed.name).toEqual("alchemy-test-renamed");
      expect(renamed.labels).toEqual({ team: "a" });
      const relabeled = yield* functions.getRevision({
        projectId,
        functionId: created.functionId,
        revisionId: updated.revisionId!,
      });
      expect(relabeled.labels?.team).toEqual("a");

      // A third revision prunes the first: one older one is kept by default.
      const third = yield* stack.deploy(
        fn({ greeting: "three", name: "alchemy-test-renamed", labels: { team: "a" } }),
      );
      const remaining = yield* functions.listRevisions({
        projectId,
        functionId: created.functionId,
      });
      expect((remaining.revisionList ?? []).map((item) => item.id).sort()).toEqual(
        [updated.revisionId, third.revisionId].sort(),
      );

      yield* stack.destroy();
      yield* expectFunctionGone(projectId, created.functionId);
    }).pipe(logLevel),
  options,
);

const Stack = Alchemy.Stack(
  "StackitFunctionsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const effectFunction = yield* EffectFunction;
    const ping = yield* Ping;
    const images = yield* Images;
    return {
      effectUrl: effectFunction.url,
      effectImage: effectFunction.image,
      effectCodeHash: effectFunction.codeHash,
      pingUrl: ping.url,
      pingFunctionId: ping.functionId,
      pingImage: ping.image,
      projectId: ping.projectId,
      registryUrl: images.url,
      registryName: images.name,
    };
  }),
);

/** A fresh function and a new key take a while to answer: retry, then report. */
const callJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status !== 200) return yield* Effect.fail(`HTTP ${response.status}`);
        return yield* response.json;
      }),
    ),
    Effect.map((body) => body as any),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe
  .skipIf(noBuiltFunctions)
  .sequential(
    "STACKIT Functions built from main",
    { tags: stackitTags("functions", "forms") },
    () => {
      const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

      test(
        "the async form serves its fetch handler, with its env as the second argument",
        Effect.gen(function* () {
          const { pingUrl } = yield* stack;
          const body = yield* callJson(`${pingUrl}/some/path`);
          expect(body).toEqual({
            form: "async",
            greeting: "hello from async",
            path: "/some/path",
          });
        }),
        { timeout: 300_000 },
      );

      test(
        "the effectful form serves its handler, with its env and the bound key delivered",
        Effect.gen(function* () {
          const { effectUrl } = yield* stack;
          const body = yield* callJson(`${effectUrl}/hello`);
          expect(body).toEqual({
            ok: true,
            result: { form: "effect", greeting: "hello from effect", keyIsPacked: true },
          });
        }),
        { timeout: 300_000 },
      );

      test(
        "a binding signs with the created key from inside the Function",
        Effect.gen(function* () {
          const { effectUrl, pingFunctionId } = yield* stack;
          const body = yield* callJson(`${effectUrl}/get-function`);
          expect(body.ok).toEqual(true);
          expect(body.result.id).toEqual(pingFunctionId);
        }),
        { timeout: 300_000 },
      );

      test(
        "Invoke calls the other function from inside the Function",
        Effect.gen(function* () {
          const { effectUrl } = yield* stack;
          const body = yield* callJson(`${effectUrl}/invoke`);
          expect(body).toEqual({
            ok: true,
            result: { form: "async", greeting: "hello from async", path: "/through-invoke" },
          });
        }),
        { timeout: 300_000 },
      );

      test(
        "a built image is pinned by digest, and that digest is in the registry",
        Effect.gen(function* () {
          const { effectImage, effectCodeHash, registryUrl, registryName } = yield* stack;
          expect(effectCodeHash).toEqual(expect.any(String));
          expect(effectImage).toMatch(/\/effect@sha256:[a-f0-9]{64}$/);
          const artifact = yield* harbor
            .getArtifact({
              project_name: registryName!,
              repository_name: "effect",
              reference: effectImage!.slice(effectImage!.indexOf("@") + 1),
            })
            .pipe(asHarborUser(registryUrl!));
          expect(artifact.digest).toEqual(effectImage!.slice(effectImage!.indexOf("@") + 1));
        }),
        { timeout: 120_000 },
      );

      test.provider(
        "the revision records the digest and the pull credential",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, pingFunctionId, pingImage } = yield* stack;
            const fn = yield* functions.getFunction({
              projectId: projectId!,
              functionId: pingFunctionId!,
            });
            const revision = yield* functions.getRevision({
              projectId: projectId!,
              functionId: pingFunctionId!,
              revisionId: fn.current_revision!,
            });
            expect(revision.oci_reference).toEqual(pingImage);
            expect(revision.oci_pull_credential_id).toEqual(expect.any(String));
            expect(plainVariables(revision)).toContainEqual({
              name: "SECRET",
              value: "not-a-secret",
            });
          }),
        { timeout: 120_000 },
      );
    },
  );
