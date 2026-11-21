import * as Kubernetes from "@alchemy.run/kubernetes";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Drift from "alchemy/Drift";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import {
  decodeBase64,
  destroyKindStack,
  KindTestCluster,
  kubectl,
  kubectlGet,
  type KindCluster,
} from "./fixtures/kind.ts";

const testOptions = { providers: Kubernetes.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

const kindStack = Core.scratchStack(testOptions, "KubernetesSecretKind");

/** A Kubernetes object name for this test run, unique per stage. */
const stageName = (prefix: string, stage: string) =>
  `${prefix}-${stage.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}`.slice(0, 63);

// Creates a real kind cluster (~30s); needs Docker, kind, and kubectl.
describe(
  "Kubernetes Secret on kind",
  {
    tags: [
      "provider:kubernetes",
      "provider:kubernetes:secret",
      "provider:kubernetes:localcluster",
      "local",
    ],
  },
  () => {
    let cluster: KindCluster;
    const ns = ["--namespace", "default"];
    const readSecret = (name: string) => kubectlGet(cluster, ["secret", name, ...ns]);
    const decoded = (secret: { data?: Record<string, string> }) =>
      Effect.forEach(Object.entries(secret.data ?? {}), ([key, value]) =>
        decodeBase64(value).pipe(Effect.map((text) => [key, text] as const)),
      ).pipe(Effect.map(Object.fromEntries));

    beforeAll(
      Effect.gen(function* () {
        yield* kindStack.destroy();
        cluster = yield* kindStack.deploy(KindTestCluster("secret", 5066));
      }),
      { timeout: 300_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.suspend(() => destroyKindStack(kindStack, cluster)),
      { timeout: 180_000 },
    );

    test.provider(
      "applies Redacted values, removes dropped keys, and reports drift",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const blob = Buffer.from([0x00, 0xff, 0x10]).toString("base64");
          const secret = (stringData: Record<string, string>) =>
            Kubernetes.Secret("Credentials", {
              cluster: cluster.connection,
              labels: { app: "secret-test" },
              stringData: Object.fromEntries(
                Object.entries(stringData).map(([key, value]) => [key, Redacted.make(value)]),
              ),
              // Line-wrapped base64, as `base64` prints it, is accepted.
              data: { "blob.bin": Redacted.make(`${blob.slice(0, 2)}\n${blob.slice(2)}`) },
            });

          const first = { username: "admin", password: "first-password-sentinel" };
          const created = yield* stack.deploy(secret(first));
          expect(created.type).toBe("Opaque");
          expect(JSON.stringify(created)).not.toContain(first.password);

          const live = yield* readSecret(created.name);
          expect(live.type).toBe("Opaque");
          expect(live.metadata.labels).toEqual({ app: "secret-test" });
          expect(live.data["blob.bin"]).toBe(blob);
          expect(yield* decoded(live)).toMatchObject(first);

          // Redeploying the same values plans nothing and reports no drift.
          const steady = yield* stack.plan(secret(first));
          expect(steady.resources.Credentials?.action).toBe("noop");
          const clean = yield* Drift.detect({ name: stack.name, stage: stack.stage });
          expect(clean.resources.Credentials?.action).toBe("unchanged");

          // Dropping a key removes it from the cluster. A Manifest that sends
          // `stringData` leaves it behind, because server-side apply records
          // ownership of `stringData` while the apiserver stores `data`.
          const second = { password: "second-password-sentinel" };
          const updated = yield* stack.deploy(secret(second));
          expect(updated.uid).toBe(created.uid);
          const rotated = yield* readSecret(created.name);
          expect(Object.keys(rotated.data).sort()).toEqual(["blob.bin", "password"]);
          expect(yield* decoded(rotated)).toMatchObject(second);

          yield* kubectl(cluster, [
            "patch",
            "secret",
            created.name,
            ...ns,
            "--type",
            "merge",
            "-p",
            JSON.stringify({ data: { password: Buffer.from("edited").toString("base64") } }),
          ]);
          const edited = yield* Drift.detect({ name: stack.name, stage: stack.stage });
          expect(edited.resources.Credentials?.action).toBe("drifted");

          yield* stack.destroy();
          expect(yield* readSecret(created.name)).toBe(undefined);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "changing the type of a named Secret deletes it and creates it again",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const name = stageName("typed", stack.stage);
          const secret = (type: string) =>
            Kubernetes.Secret("Typed", {
              cluster: cluster.connection,
              name,
              type,
              stringData: {
                username: Redacted.make("admin"),
                password: Redacted.make("typed-password-sentinel"),
              },
            });

          const opaque = yield* stack.deploy(secret("Opaque"));
          expect((yield* readSecret(name)).type).toBe("Opaque");

          const plan = yield* stack.plan(secret("kubernetes.io/basic-auth"));
          expect(plan.resources.Typed?.action).toBe("replace");

          const basicAuth = yield* stack.deploy(secret("kubernetes.io/basic-auth"));
          expect(basicAuth.name).toBe(name);
          expect(basicAuth.type).toBe("kubernetes.io/basic-auth");
          expect(basicAuth.uid).not.toBe(opaque.uid);
          const live = yield* readSecret(name);
          expect(live.type).toBe("kubernetes.io/basic-auth");
          expect(live.metadata.uid).toBe(basicAuth.uid);
          expect(yield* decoded(live)).toEqual({
            username: "admin",
            password: "typed-password-sentinel",
          });

          yield* stack.destroy();
          expect(yield* readSecret(name)).toBe(undefined);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "refuses a Secret that another controller owns and leaves it untouched",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const owner = stageName("secret-owner", stack.stage);
          const name = stageName("owned", stack.stage);
          // The owner must exist, or the garbage collector deletes the Secret.
          yield* kubectl(
            cluster,
            ["apply", "-f", "-"],
            JSON.stringify({
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: { name: owner, namespace: "default" },
            }),
          );
          const ownerUid = (yield* kubectlGet(cluster, ["configmap", owner, ...ns])).metadata.uid;
          yield* kubectl(
            cluster,
            ["apply", "-f", "-"],
            JSON.stringify({
              apiVersion: "v1",
              kind: "Secret",
              metadata: {
                name,
                namespace: "default",
                ownerReferences: [
                  {
                    apiVersion: "v1",
                    kind: "ConfigMap",
                    name: owner,
                    uid: ownerUid,
                    controller: true,
                  },
                ],
              },
              stringData: { token: "from-the-controller" },
            }),
          );

          const exit = yield* Effect.exit(
            stack.deploy(
              Kubernetes.Secret("Owned", {
                cluster: cluster.connection,
                name,
                stringData: { token: Redacted.make("from-alchemy") },
              }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
          expect(failure).toContain("SecretControlledByOwner");
          expect(failure).toContain(`v1/ConfigMap ${owner}`);
          expect(failure).not.toContain("from-alchemy");
          expect(yield* decoded(yield* readSecret(name))).toEqual({ token: "from-the-controller" });

          // The stack never owned it, so destroying the stack leaves it.
          yield* stack.destroy();
          expect(yield* readSecret(name)).not.toBe(undefined);
          yield* kubectl(cluster, ["delete", "configmap", owner, ...ns]);
          yield* kubectl(cluster, ["delete", "secret", name, ...ns, "--ignore-not-found"]);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "rejects a key in both stringData and data, and data that is not base64",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const failure = (props: Pick<Kubernetes.SecretProps, "stringData" | "data">) =>
            Effect.exit(
              stack.deploy(Kubernetes.Secret("Invalid", { cluster: cluster.connection, ...props })),
            ).pipe(
              Effect.map((exit) => {
                expect(Exit.isFailure(exit)).toBe(true);
                return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
              }),
            );

          const overlap = yield* failure({
            stringData: { token: Redacted.make("a") },
            data: { token: Redacted.make("Yg==") },
          });
          expect(overlap).toContain("SecretInvalidProps");
          expect(overlap).toContain("only one of stringData and data: token");

          const notBase64 = yield* failure({
            data: { ok: Redacted.make("AP8Q"), raw: Redacted.make("not-base64-sentinel!") },
          });
          expect(notBase64).toContain("SecretInvalidProps");
          expect(notBase64).toContain("standard padded base64: raw");
          expect(notBase64).not.toContain("not-base64-sentinel");

          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );
  },
);
