/**
 * Vercel Function (async mode) lifecycle tests — live against the standing
 * Vercel test team (run with the doppler alchemy-v2/dev env).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import { syncProjectEnv } from "@/Vercel/Deploy/Engine.ts";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/handler.ts", import.meta.url).pathname;

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "deploy, drive, redeploy (skip-on-hash), env update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeFn = (greeting: string) =>
        Effect.gen(function* () {
          return yield* Vercel.Function("Fn", {
            main: fixtureMain,
            env: { GREETING: greeting },
          });
        });

      // 1. Greenfield deploy.
      const created = yield* stack.deploy(makeFn("hello"));
      expect(created.projectId).toBeDefined();
      expect(created.deploymentId).toBeDefined();
      expect(created.url).toBeDefined();

      // 2. Out-of-band verification via distilled: deployment is READY and
      //    carries the alchemy meta stamps.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const page = yield* deployments.getDeployments({
        teamId,
        projectId: created.projectId,
        limit: 10,
      });
      const deployed = page.deployments.find(
        (d) => d.uid === created.deploymentId,
      );
      expect(deployed).toBeDefined();
      expect(deployed!.readyState).toEqual("READY");
      expect(deployed!.meta?.alchemyLogicalId).toEqual("Fn");
      expect(deployed!.meta?.alchemyContentHash).toBeDefined();

      // 3. Drive the deployed function over HTTP (first-request retry).
      const root = (yield* getJson(`${created.url}/`)) as { ok: boolean };
      expect(root.ok).toBe(true);
      const env = (yield* getJson(`${created.url}/env`)) as {
        greeting: string | null;
      };
      expect(env.greeting).toEqual("hello");

      // 4. Redeploy with no changes: skip-on-hash keeps the deployment.
      const redeployed = yield* stack.deploy(makeFn("hello"));
      expect(redeployed.projectId).toEqual(created.projectId);
      expect(redeployed.deploymentId).toEqual(created.deploymentId);

      // 5. Env change forces a new immutable deployment (Vercel env only
      //    takes effect on new deployments).
      const updated = yield* stack.deploy(makeFn("bonjour"));
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.deploymentId).not.toEqual(created.deploymentId);
      const updatedEnv = (yield* getJson(`${updated.url}/env`)) as {
        greeting: string | null;
      };
      expect(updatedEnv.greeting).toEqual("bonjour");

      // 6. Destroy cascades the owned project; typed wait-until-gone.
      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "inline script function deploys and serves",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const script = `export default {
  fetch(request) {
    return Response.json({ inline: true, url: request.url });
  },
};
`;
      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Function("Inline", { script });
        }),
      );
      expect(fn.url).toBeDefined();
      const body = (yield* getJson(`${fn.url}/`)) as { inline: boolean };
      expect(body.inline).toBe(true);

      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "sensitive env: hidden from listing, no redeploy churn, rotation redeploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeFn = (secret: string) =>
        Effect.gen(function* () {
          return yield* Vercel.Function("SecretFn", {
            main: fixtureMain,
            env: {
              GREETING: "hi",
              SECRET_VALUE: Redacted.make(secret),
            },
          });
        });

      const created = yield* stack.deploy(makeFn("s3cret"));

      // Platform pin (live-verified): sensitive rows ARE listed but
      // write-only — `value` comes back EMPTY even with decrypt=true (only
      // the fingerprint comment is readable), and creating one targeting
      // `development` is rejected outright (why SENSITIVE_ENV_TARGETS
      // excludes it). Values are unobservable (this team's encrypted rows
      // also list as `decrypted: false` ciphertext), so the drift baseline
      // lives in persisted state.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const envs = yield* projects.filterProjectEnvs({
        idOrName: created.projectId,
        teamId,
        decrypt: "true",
      });
      const rows = (
        Array.isArray(envs)
          ? envs
          : typeof envs === "object" && envs !== null && "envs" in envs
            ? envs.envs
            : []
      ) as Array<{
        key: string;
        type: string;
        value?: string;
        comment?: string;
      }>;
      const secret = rows.find((row) => row.key === "SECRET_VALUE");
      expect(secret).toBeDefined();
      expect(secret!.type).toEqual("sensitive");
      expect(secret!.value).toEqual("");
      expect(secret!.comment).toMatch(/^alchemy:sha256:/);
      const greeting = rows.find((row) => row.key === "GREETING");
      expect(greeting).toBeDefined();
      expect(greeting!.type).toEqual("encrypted");

      // The runtime sees the secret as a plain env string.
      const env = (yield* getJson(`${created.url}/env`)) as {
        secret: boolean;
        secretValue: string | null;
      };
      expect(env.secret).toBe(true);
      expect(env.secretValue).toEqual("s3cret");

      // CHURN REGRESSION (engine level): re-syncing the identical desired
      // env against the persisted baseline must be a no-op even though the
      // sensitive/encrypted values are unobservable in the listing. This is
      // exactly what reconcile does — a `changed: true` here would force a
      // redeploy on every deploy.
      const meta = rows.find((row) => row.key === "ALCHEMY_META");
      expect(meta?.value).toBeDefined();
      const resync = yield* syncProjectEnv({
        idOrName: created.projectId,
        desired: [
          { key: "GREETING", value: "hi" },
          { key: "SECRET_VALUE", value: Redacted.make("s3cret") },
          { key: "ALCHEMY_META", value: meta!.value!, type: "plain" },
        ],
        managedEnv: created.managedEnv,
      });
      expect(resync.changed).toBe(false);

      // CHURN REGRESSION (stack level): an identical second deploy keeps
      // the same deployment.
      const redeployed = yield* stack.deploy(makeFn("s3cret"));
      expect(redeployed.projectId).toEqual(created.projectId);
      expect(redeployed.deploymentId).toEqual(created.deploymentId);

      // Rotating the Redacted value DOES redeploy (env only takes effect
      // on new deployments) and the runtime sees the new value.
      const rotated = yield* stack.deploy(makeFn("r0tated"));
      expect(rotated.projectId).toEqual(created.projectId);
      expect(rotated.deploymentId).not.toEqual(created.deploymentId);
      const rotatedEnv = (yield* getJson(`${rotated.url}/env`).pipe(
        // The production alias may briefly serve the previous deployment.
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) =>
            (body as { secretValue: string | null }).secretValue === "r0tated",
          times: 15,
        }),
      )) as { secretValue: string | null };
      expect(rotatedEnv.secretValue).toEqual("r0tated");

      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
