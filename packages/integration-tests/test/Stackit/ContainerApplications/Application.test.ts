import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, stackitTags } from "../helpers.ts";
import BackgroundApplication from "./fixtures/background-application.ts";
import EffectApplication from "./fixtures/effect-application.ts";
import { Ping } from "./fixtures/stack.ts";
import {
  EXAMPLE_IMAGE,
  ensureTestEnvironment,
  expectApplicationGone,
  noApplications,
  noBuiltApplications,
  secretKeys,
  sharedEnvironment,
} from "./helpers.ts";

const providers = Stackit.providers();

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const options = {
  tags: stackitTags("containerapplications", "application"),
  timeout: 1_200_000,
} as const;

const failure = {
  tags: stackitTags("containerapplications", "application"),
  timeout: 120_000,
} as const;

/** Read a deployed application out of band. */
const observed = (
  scope: { projectId: string; region: string; environmentId: string },
  applicationId: string,
) => sca.getApplication({ ...scope, applicationId });

/** An environment variable as plain text: the SDK keeps its value `Redacted`. */
const variable = (app: sca.Application, key: string) => {
  const found = app.containers[0]?.environmentVariables?.find((item) => item.key === key);
  return found === undefined
    ? undefined
    : {
        origin: found.origin,
        value: Redacted.isRedacted(found.value) ? Redacted.value(found.value) : found.value,
      };
};

test.provider(
  "an application with nothing to run fails before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Stackit.ContainerApplications.Application("NoSource", { environmentId: "never-reached" }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "Stackit.ContainerApplications.ApplicationSourceRequired",
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  failure,
);

test.provider(
  "main with no registry fails before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Stackit.ContainerApplications.Application("NoRegistry", {
            environmentId: "never-reached",
            main: "./src/never-read.ts",
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "Stackit.ContainerApplications.ApplicationRegistryRequired",
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  failure,
);

test.provider(
  "a background loop that would scale to zero fails before anything is built",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack.deploy(BackgroundApplication).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "Stackit.ContainerApplications.ApplicationBackgroundWorkScalesToZero",
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  failure,
);

test.provider.skipIf(noApplications)(
  "a public image: create, update in place, keep secrets out of its config, and delete",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();

      const app = (props: {
        greeting: string;
        token: string;
        instances?: number;
        stopped?: boolean;
        displayName?: string;
      }) =>
        Stackit.ContainerApplications.Application("Lifecycle", {
          environmentId: scope.environmentId,
          image: EXAMPLE_IMAGE,
          displayName: props.displayName,
          env: { GREETING: props.greeting, TOKEN: Redacted.make(props.token) },
          scaling:
            props.instances !== undefined
              ? { type: "manual", instances: props.instances }
              : undefined,
          stopped: props.stopped,
        });

      const created = yield* stack.deploy(app({ greeting: "one", token: "first" }));
      expect(created.environmentId).toEqual(scope.environmentId);
      expect(created.url).toMatch(/^https:\/\//);
      expect(["CURRENT_STATUS_RUNNING", "CURRENT_STATUS_IDLE"]).toContain(created.status);

      // Out of band: the configuration Alchemy sent, with the secret only referenced.
      const fetched = yield* observed(scope, created.applicationId);
      expect(fetched.containers[0]?.image).toEqual(EXAMPLE_IMAGE);
      expect(fetched.scaling.type).toEqual("SCALING_TYPE_AUTO");
      expect(fetched.scaling.autoScaling).toMatchObject({
        minInstances: 0,
        maxInstances: 1,
        allowScaleToZero: true,
      });
      expect(fetched.network?.public).toMatchObject({ enabled: true, port: 8080 });
      expect(variable(fetched, "GREETING")).toEqual({
        origin: "ENV_FROM_SOURCE_TYPE_MANUAL",
        value: "one",
      });
      const stagedKey = created.stagedSecrets[0]!;
      expect(variable(fetched, "TOKEN")).toEqual({
        origin: "ENV_FROM_SOURCE_TYPE_SECRET",
        value: stagedKey,
      });
      expect(yield* secretKeys(scope)).toContain(stagedKey);

      // Its URL serves the image's own page.
      const page = yield* HttpClient.get(created.url!).pipe(
        Effect.timeout("30 seconds"),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200) return yield* Effect.fail(`HTTP ${response.status}`);
            return response.status;
          }),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
      );
      expect(page).toEqual(200);

      const unchanged = yield* stack.plan(app({ greeting: "one", token: "first" }));
      expect(unchanged.resources.Lifecycle).toMatchObject({ action: "noop" });

      const updated = yield* stack.deploy(app({ greeting: "two", token: "first", instances: 1 }));
      expect(updated.applicationId).toEqual(created.applicationId);
      const afterUpdate = yield* observed(scope, created.applicationId);
      expect(variable(afterUpdate, "GREETING")?.value).toEqual("two");
      expect(afterUpdate.scaling).toMatchObject({
        type: "SCALING_TYPE_MANUAL",
        manualScaling: { instances: 1 },
      });

      // A new secret value changes the application, so it rolls out.
      const rotated = yield* stack.deploy(app({ greeting: "two", token: "second", instances: 1 }));
      const afterRotation = yield* observed(scope, rotated.applicationId);
      expect(variable(afterRotation, "ALCHEMY_STACKIT_SECRETS_VERSION")?.value).not.toEqual(
        variable(afterUpdate, "ALCHEMY_STACKIT_SECRETS_VERSION")?.value,
      );

      const stopped = yield* stack.deploy(
        app({ greeting: "two", token: "second", instances: 1, stopped: true }),
      );
      expect(stopped.status).toEqual("CURRENT_STATUS_NONE");

      // Renaming updates in place.
      const renamed = yield* stack.deploy(
        app({
          greeting: "two",
          token: "second",
          instances: 1,
          stopped: true,
          displayName: "alchemy-test-renamed",
        }),
      );
      expect(renamed.applicationId).toEqual(created.applicationId);
      expect(renamed.displayName).toEqual("alchemy-test-renamed");

      yield* stack.destroy();
      yield* expectApplicationGone(scope, created.applicationId);
      expect(yield* secretKeys(scope)).not.toContain(renamed.stagedSecrets[0]);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noApplications)(
  "a new environment replaces the application and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const first = yield* sharedEnvironment;
      const second = yield* ensureTestEnvironment("alchemy-test-sca-second");
      yield* stack.destroy();

      const app = (environmentId: string) =>
        Stackit.ContainerApplications.Application("Replaced", {
          environmentId,
          image: EXAMPLE_IMAGE,
        });

      const created = yield* stack.deploy(app(first.environmentId));
      const replaced = yield* stack.deploy(app(second.environmentId));
      expect(replaced.environmentId).toEqual(second.environmentId);
      expect(replaced.applicationId).not.toEqual(created.applicationId);
      yield* expectApplicationGone(first, created.applicationId);

      yield* stack.destroy();
      yield* expectApplicationGone(second, replaced.applicationId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noApplications)(
  "an application under a chosen name is refused without adoption",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();
      const displayName = "alchemy-test-foreign";
      yield* Effect.acquireUseRelease(
        sca.createApplication({
          ...scope,
          displayName,
          containers: [{ name: "app", image: EXAMPLE_IMAGE }],
          scaling: { type: "SCALING_TYPE_MANUAL", manualScaling: { instances: 1 } },
        }),
        (foreign) =>
          Effect.gen(function* () {
            const error = yield* stack
              .deploy(
                Stackit.ContainerApplications.Application("Foreign", {
                  environmentId: scope.environmentId,
                  displayName,
                  image: EXAMPLE_IMAGE,
                }),
              )
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");
            // The foreign application was neither changed nor removed.
            const after = yield* observed(scope, foreign.id!);
            expect(after.scaling.type).toEqual("SCALING_TYPE_MANUAL");
          }),
        (foreign) =>
          sca
            .deleteApplication({ ...scope, applicationId: foreign.id! })
            .pipe(Effect.andThen(expectApplicationGone(scope, foreign.id!)), Effect.ignore),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

const Stack = Alchemy.Stack(
  "StackitScaFormsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const effect = yield* EffectApplication;
    const ping = yield* Ping;
    return {
      effectUrl: effect.url,
      effectImage: effect.image,
      effectCodeHash: effect.codeHash,
      pingUrl: ping.url,
      pingApplicationId: ping.applicationId,
    };
  }),
);

/** A fresh application and a new key take a while to answer: retry, then report. */
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
  .skipIf(noBuiltApplications)
  .sequential(
    "STACKIT Container Applications built from main",
    { tags: stackitTags("containerapplications", "forms") },
    () => {
      const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

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
        "a binding signs with the created key from inside the Application",
        Effect.gen(function* () {
          const { effectUrl, pingApplicationId } = yield* stack;
          const body = yield* callJson(`${effectUrl}/get-application`);
          expect(body.ok).toEqual(true);
          expect(body.result.id).toEqual(pingApplicationId);
        }),
        { timeout: 300_000 },
      );

      test(
        "a built image is pinned by digest",
        Effect.gen(function* () {
          const { effectImage, effectCodeHash } = yield* stack;
          expect(effectCodeHash).toEqual(expect.any(String));
          expect(effectImage).toMatch(/\/effect@sha256:[a-f0-9]{64}$/);
        }),
        { timeout: 60_000 },
      );
    },
  );
