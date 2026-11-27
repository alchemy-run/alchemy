import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

/**
 * A `Redacted` env value of a Cloud Run host lives in a Secret Manager
 * secret of the host's own, which the revision names through
 * `secretKeyRef`; the revision never holds the value.
 */
const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tags = ["provider:gcp", "provider:gcp:run", "live"];

const WORKER_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";
const JOB_IMAGE = "us-docker.pkg.dev/cloudrun/container/job:latest";
const SERVICE_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

type EnvList = ReadonlyArray<cloudrun.GoogleCloudRunV2EnvVar> | undefined;

const projectOf = (name: string) => name.split("/")[1]!;

/** The `secretKeyRef` of `key`, asserting the revision holds no plain value for it. */
const secretRefOf = (env: EnvList, key: string) => {
  const entry = (env ?? []).find((item) => item.name === key);
  expect(entry?.value).toBeUndefined();
  const ref = entry?.valueSource?.secretKeyRef;
  expect(ref?.secret).toMatch(/^alch-[0-9a-f]{12}-/);
  expect(ref?.version).toMatch(/^\d+$/);
  return { secret: ref!.secret!, version: ref!.version! };
};

const secretName = (project: string, secret: string) => `projects/${project}/secrets/${secret}`;

const readVersion = (project: string, secret: string, version: string) =>
  secretmanager
    .accessProjectsSecretsVersions({
      name: `${secretName(project, secret)}/versions/${version}`,
    })
    .pipe(Effect.map((res) => Buffer.from(res.payload?.data ?? "", "base64").toString("utf8")));

const versionState = (project: string, secret: string, version: string) =>
  secretmanager
    .getProjectsSecretsVersions({ name: `${secretName(project, secret)}/versions/${version}` })
    .pipe(Effect.map((res) => res.state));

/** Wait until the secret is gone (deletion reads back with a short lag). */
const waitUntilSecretGone = (project: string, secret: string) =>
  secretmanager.getProjectsSecrets({ name: secretName(project, secret) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "a worker pool's Redacted env lives in Secret Manager across rotation and removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = (token: string | undefined) =>
        stack.deploy(
          GCP.Run.WorkerPool("SecretPool", {
            location: "us-central1",
            scaling: { manualInstanceCount: 0 },
            template: { containers: [{ image: WORKER_IMAGE }] },
            env: {
              PLAIN: "visible",
              ...(token === undefined ? {} : { TOKEN: Redacted.make(token) }),
            },
          }),
        );

      const created = yield* pool("v1-secret");
      const project = projectOf(created.name);
      const first = yield* cloudrun.getProjectsLocationsWorkerPools({ name: created.name });
      const firstEnv = first.template?.containers?.[0]?.env;
      const v1 = secretRefOf(firstEnv, "TOKEN");
      expect(JSON.stringify(firstEnv)).not.toContain("v1-secret");
      expect(firstEnv?.find((item) => item.name === "PLAIN")?.value).toBe("visible");
      expect(yield* readVersion(project, v1.secret, v1.version)).toBe("v1-secret");
      expect(created.secretEnv).toEqual([v1.secret]);

      // A redeploy with the same value keeps the version (no new revision).
      yield* pool("v1-secret");
      const same = yield* cloudrun.getProjectsLocationsWorkerPools({ name: created.name });
      expect(secretRefOf(same.template?.containers?.[0]?.env, "TOKEN")).toEqual(v1);
      expect(same.latestReadyRevision).toEqual(first.latestReadyRevision);

      // A new value is a new version of the same secret, rolled out; the old
      // version is destroyed once no revision runs on it.
      yield* pool("v2-secret");
      const rotated = yield* cloudrun.getProjectsLocationsWorkerPools({ name: created.name });
      const v2 = secretRefOf(rotated.template?.containers?.[0]?.env, "TOKEN");
      expect(v2.secret).toEqual(v1.secret);
      expect(v2.version).not.toEqual(v1.version);
      expect(rotated.latestReadyRevision).not.toEqual(first.latestReadyRevision);
      expect(yield* readVersion(project, v2.secret, v2.version)).toBe("v2-secret");
      expect(yield* versionState(project, v1.secret, v1.version)).toBe("DESTROYED");

      // Dropping the key deletes its secret once the rollout is done.
      const dropped = yield* pool(undefined);
      const plain = yield* cloudrun.getProjectsLocationsWorkerPools({ name: created.name });
      expect(plain.template?.containers?.[0]?.env?.some((item) => item.name === "TOKEN")).toBe(
        false,
      );
      expect(dropped.secretEnv).toEqual([]);
      expect(yield* waitUntilSecretGone(project, v1.secret)).toBe("gone");

      // Destroying the pool deletes its secrets.
      yield* pool("v3-secret");
      const again = yield* cloudrun.getProjectsLocationsWorkerPools({ name: created.name });
      const v3 = secretRefOf(again.template?.containers?.[0]?.env, "TOKEN");
      yield* stack.destroy();
      expect(yield* waitUntilSecretGone(project, v3.secret)).toBe("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider(
  "a job's Redacted env lives in Secret Manager and goes with the job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const job = yield* stack.deploy(
        GCP.Run.Job("SecretJob", {
          location: "us-central1",
          containers: [{ image: JOB_IMAGE }],
          env: { PLAIN: "visible", TOKEN: Redacted.make("job-secret") },
        }),
      );
      const project = projectOf(job.name);
      const fetched = yield* cloudrun.getProjectsLocationsJobs({ name: job.name });
      const env = fetched.template?.template?.containers?.[0]?.env;
      const ref = secretRefOf(env, "TOKEN");
      expect(JSON.stringify(env)).not.toContain("job-secret");
      expect(env?.find((item) => item.name === "PLAIN")?.value).toBe("visible");
      expect(yield* readVersion(project, ref.secret, ref.version)).toBe("job-secret");

      yield* stack.destroy();
      expect(yield* waitUntilSecretGone(project, ref.secret)).toBe("gone");
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

test.provider(
  "a sidecar container's Redacted env lives in a secret of the service that runs it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          const sidecar = yield* GCP.Run.Container("SecretSidecar", {
            image: "docker.io/library/nginx:1.27-alpine",
            port: 80,
            startupProbe: { tcpSocket: {}, periodSeconds: 2, failureThreshold: 30 },
            env: { SIDECAR_TOKEN: Redacted.make("sidecar-secret") },
          });
          return yield* GCP.Run.Service("SecretSidecarService", {
            location: "us-central1",
            template: {
              containers: [{ image: SERVICE_IMAGE, ports: [{ containerPort: 8080 }] }, sidecar],
            },
          });
        }),
      );
      const project = projectOf(service.name);
      const fetched = yield* cloudrun.getProjectsLocationsServices({ name: service.name });
      const sidecar = fetched.template?.containers?.find(
        (container) => container.name === "secretsidecar",
      );
      const ref = secretRefOf(sidecar?.env, "SIDECAR_TOKEN");
      expect(ref.secret).toContain("-secretsidecar-");
      expect(JSON.stringify(fetched.template)).not.toContain("sidecar-secret");
      expect(yield* readVersion(project, ref.secret, ref.version)).toBe("sidecar-secret");

      yield* stack.destroy();
      expect(yield* waitUntilSecretGone(project, ref.secret)).toBe("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
