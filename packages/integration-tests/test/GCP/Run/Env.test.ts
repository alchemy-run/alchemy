import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedBound, expectedEnv, getJson } from "../../EnvValues.ts";
import EnvService from "./fixtures/env-service.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: GCP.providers() });

const Stack = Alchemy.Stack(
  "GcpRunEnvStack",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const service = yield* EnvService;
    return {
      url: service.uri.as<string>(),
      name: service.name,
      serviceAccount: service.serviceAccount.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

const withGcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, { providers: GCP.providers() }, "GcpRunEnvStack");

test(
  "Cloud Run deploys every env value as the string the process reads",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual({ values: expectedEnv, bound: expectedBound });
  }),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);

test(
  "a Cloud Run revision reads its Redacted env from Secret Manager, never holds it",
  Effect.gen(function* () {
    const { name, serviceAccount } = yield* stack;
    const service = yield* withGcp(cloudrun.getProjectsLocationsServices({ name }));
    const env = service.template?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((entry) => [entry.name, entry]));

    // The `env` prop's `Redacted`s, and one bound in Init through the
    // runtime context (packed with a Redacted marker).
    for (const key of ["ENV_SECRET", "ENV_SECRET_OBJECT", "ENV_BOUND_SECRET"]) {
      const entry = byName.get(key);
      expect(entry?.value).toBeUndefined();
      expect(entry?.valueSource?.secretKeyRef?.secret).toMatch(/^alch-[0-9a-f]{12}-main-/);
      expect(entry?.valueSource?.secretKeyRef?.version).toMatch(/^\d+$/);
    }
    // Nor under another key.
    const text = JSON.stringify(env);
    expect(text).not.toContain("s3cret");
    // `ENV_JSONISH` is a plain value that happens to start with the same digits.
    expect(
      env.filter((entry) => entry.name !== "ENV_JSONISH" && entry.value?.includes("123456")),
    ).toEqual([]);
    expect(text).not.toContain("Redacted");
    // Plain values stay plain.
    expect(byName.get("ENV_PLAIN")?.value).toBe("hello");
    expect(byName.get("ENV_BOUND_PLAIN")?.value).toBe("my-queue");

    // The secret holds the string the process reads, and only the
    // service's account is granted to read it.
    const project = name.split("/")[1]!;
    const ref = byName.get("ENV_SECRET")!.valueSource!.secretKeyRef!;
    const secret = `projects/${project}/secrets/${ref.secret}`;
    const accessed = yield* withGcp(
      secretmanager.accessProjectsSecretsVersions({ name: `${secret}/versions/${ref.version}` }),
    );
    expect(Buffer.from(accessed.payload?.data ?? "", "base64").toString("utf8")).toBe("s3cret");
    const policy = yield* withGcp(secretmanager.getIamPolicyProjectsSecrets({ resource: secret }));
    expect(policy.bindings).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        members: [`serviceAccount:${serviceAccount}`],
      },
    ]);
  }),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);
