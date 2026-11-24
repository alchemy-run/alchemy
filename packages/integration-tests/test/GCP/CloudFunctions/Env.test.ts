import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../../EnvValues.ts";
import EnvFunction from "./fixtures/env-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: GCP.providers() });

const Stack = Alchemy.Stack(
  "GcpCloudFunctionsEnvStack",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvFunction;
    // Let the test call the function without an identity token.
    yield* GCP.IAM.Member("PublicInvoker", {
      kind: "run.service",
      name: fn.service.as<string>(),
      role: "roles/run.invoker",
      member: "allUsers",
    });
    return {
      url: fn.url.as<string>(),
      name: fn.name,
      serviceAccount: fn.serviceAccountEmail.as<string>(),
    };
  }),
);

const withGcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, { providers: GCP.providers() }, "GcpCloudFunctionsEnvStack");

// Cloud Build + function provisioning is slow.
describe.skipIf(!!process.env.FAST)("env values", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

  test(
    "Cloud Functions deploys every env value as the string the process reads",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(yield* getJson(url)).toEqual(expectedEnv);
    }),
    { tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"], timeout: 120_000 },
  );

  test(
    "a Cloud Function reads its Redacted env from Secret Manager, never holds it",
    Effect.gen(function* () {
      const { name, serviceAccount } = yield* stack;
      const fn = yield* withGcp(cloudfunctions.getProjectsLocationsFunctions({ name }));
      const plain = fn.serviceConfig?.environmentVariables ?? {};
      const secrets = new Map(
        (fn.serviceConfig?.secretEnvironmentVariables ?? []).map((entry) => [entry.key, entry]),
      );

      for (const key of ["ENV_SECRET", "ENV_SECRET_OBJECT"]) {
        expect(key in plain).toBe(false);
        expect(secrets.get(key)?.secret).toMatch(/^alch-[0-9a-f]{12}-main-/);
        expect(secrets.get(key)?.version).toMatch(/^\d+$/);
      }
      // Nor under another key.
      const text = JSON.stringify(fn.serviceConfig);
      expect(text).not.toContain("s3cret");
      expect(text).not.toContain("Redacted");
      // Plain values stay plain.
      expect(plain.ENV_PLAIN).toBe("hello");

      // The secret holds the string the process reads, and only the
      // function's account is granted to read it.
      const project = name.split("/")[1]!;
      const ref = secrets.get("ENV_SECRET")!;
      const secret = `projects/${project}/secrets/${ref.secret}`;
      const accessed = yield* withGcp(
        secretmanager.accessProjectsSecretsVersions({ name: `${secret}/versions/${ref.version}` }),
      );
      expect(Buffer.from(accessed.payload?.data ?? "", "base64").toString("utf8")).toBe("s3cret");
      const policy = yield* withGcp(
        secretmanager.getIamPolicyProjectsSecrets({ resource: secret }),
      );
      expect(policy.bindings).toEqual([
        {
          role: "roles/secretmanager.secretAccessor",
          members: [`serviceAccount:${serviceAccount}`],
        },
      ]);
    }),
    { tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"], timeout: 120_000 },
  );
});
