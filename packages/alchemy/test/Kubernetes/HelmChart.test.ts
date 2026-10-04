import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as AWS from "@/AWS";
import * as Kubernetes from "@/Kubernetes";
import { HelmError, parseRenderedManifests, renderHelmChart } from "@/Kubernetes/internal/helm.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()) };
const { test } = Test.make(testOptions);

// Rendering shells out to the local helm CLI (like Docker for image
// builds) — `helm` must be installed on the machine running this suite.
const chartDir = `${import.meta.dirname}/fixtures/chart`;

const describe = layer(NodeServices.layer);

const expectValuesFileGone = (secret: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const probe = yield* fs.makeTempDirectory({ prefix: "alchemy-helm-probe-" });
    const tmp = path.dirname(probe);
    yield* fs.remove(probe, { recursive: true });
    const entries = yield* fs.readDirectory(tmp);
    for (const entry of entries) {
      if (!entry.startsWith("alchemy-helm-")) continue;
      const valuesFile = path.join(tmp, entry, "values.json");
      if (!(yield* fs.exists(valuesFile))) continue;
      expect(yield* fs.readFileString(valuesFile)).not.toContain(secret);
    }
  });

describe("renderHelmChart (local fixture)", (it) => {
  it.effect(
    "renders values, release name, and namespace",
    () =>
      Effect.gen(function* () {
        const objects = yield* renderHelmChart({
          chart: chartDir,
          releaseName: "probe",
          namespace: "demo",
          values: { message: "hello-from-values" },
        });
        expect(objects).toHaveLength(1);
        const configMap = objects[0]! as unknown as {
          kind: string;
          metadata: { name: string };
          data: Record<string, string>;
        };
        expect(configMap.kind).toBe("ConfigMap");
        expect(configMap.metadata.name).toBe("probe-config");
        expect(configMap.data.message).toBe("hello-from-values");
        expect(configMap.data.release).toBe("probe");
        expect(configMap.data.namespace).toBe("demo");
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "unwraps Redacted values before writing the values file",
    () =>
      Effect.gen(function* () {
        const secret = "helm-values-sentinel";
        const objects = yield* renderHelmChart({
          chart: chartDir,
          releaseName: "probe",
          namespace: "demo",
          values: { message: Redacted.make(secret) },
        });
        const configMap = objects[0] as unknown as { data: { message: string } };
        expect(configMap.data.message).toBe(secret);
        expect(configMap.data.message).not.toBe("<redacted>");
        yield* expectValuesFileGone(secret);
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "values toggle conditional templates on and off",
    () =>
      Effect.gen(function* () {
        const withoutSecond = yield* renderHelmChart({
          chart: chartDir,
          releaseName: "probe",
          namespace: "demo",
        });
        expect(withoutSecond).toHaveLength(1);

        const withSecond = yield* renderHelmChart({
          chart: chartDir,
          releaseName: "probe",
          namespace: "demo",
          values: { secondConfigMap: { enabled: true } },
        });
        expect(withSecond).toHaveLength(2);
        expect(withSecond.map((object) => object.metadata.name).sort()).toEqual([
          "probe-config",
          "probe-second",
        ]);
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  // Regression for #1312: the fixture chart ships a `helm.sh/hook: pre-delete`
  // Job. HelmChart has no Helm release and no hook lifecycle, so the hook
  // must never enter the managed-object graph (where it would be created and
  // reconciled like an ordinary workload on every deploy).
  it.effect(
    "excludes Helm lifecycle hooks from the render",
    () =>
      Effect.gen(function* () {
        const objects = yield* renderHelmChart({
          chart: chartDir,
          releaseName: "probe",
          namespace: "demo",
        });
        expect(objects.map((object) => object.kind)).not.toContain("Job");
        expect(objects.map((object) => object.metadata.name)).toEqual(["probe-config"]);
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "scrubs Redacted values from helm stderr",
    () =>
      Effect.gen(function* () {
        const secret = "helm-stderr-sentinel";
        const result = yield* Effect.result(
          renderHelmChart({
            chart: chartDir,
            releaseName: "probe",
            namespace: "demo",
            values: { message: Redacted.make(secret), fail: true },
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("HelmError");
          expect(result.failure.message).not.toContain(secret);
          expect(result.failure.message).toContain("<redacted>");
        }
        yield* expectValuesFileGone(secret);
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "a bad chart reference fails with a typed HelmError",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          renderHelmChart({
            chart: `${chartDir}-does-not-exist`,
            releaseName: "probe",
            namespace: "demo",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("HelmError");
        }
      }),
    { tags: ["provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );
});

describe("parseRenderedManifests", (it) => {
  it.effect(
    "ignores Helm OCI pull metadata",
    () =>
      Effect.gen(function* () {
        const objects = yield* parseRenderedManifests(
          "oci://registry.example.test/charts/example",
          `Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
`,
        );

        expect(objects).toHaveLength(1);
        expect(objects[0]?.kind).toBe("ConfigMap");
        expect(objects[0]?.metadata.name).toBe("example");
      }),
    { tags: ["unit", "provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "excludes helm.sh/hook-annotated objects (#1312)",
    () =>
      Effect.gen(function* () {
        const objects = yield* parseRenderedManifests(
          "example",
          `apiVersion: v1
kind: ConfigMap
metadata:
  name: ordinary
---
apiVersion: batch/v1
kind: Job
metadata:
  name: uninstall-hook
  annotations:
    helm.sh/hook: pre-delete
---
apiVersion: v1
kind: Pod
metadata:
  name: smoke-test
  annotations:
    "helm.sh/hook": test
`,
        );

        expect(objects.map((object) => object.metadata.name)).toEqual(["ordinary"]);
      }),
    { tags: ["unit", "provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "rejects pull-shaped metadata for non-OCI charts",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          parseRenderedManifests(
            "example",
            `Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
`,
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("HelmError");
        }
      }),
    { tags: ["unit", "provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  it.effect(
    "rejects pull metadata that is not the leading OCI preamble",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          parseRenderedManifests(
            "oci://registry.example.test/charts/example",
            `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
---
Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
`,
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("HelmError");
        }
      }),
    { tags: ["unit", "provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
  );

  const parserTags = [
    "unit",
    "provider:kubernetes",
    "provider:kubernetes:helmchart",
    "local",
  ] as const;

  const expectScrubbedMessage = (
    result: Result.Result<unknown, { message: string }>,
    secret: string,
    includes: string,
  ) => {
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain(includes);
    expect(result.failure.message).toContain("<redacted>");
    expect(result.failure.message).not.toContain(secret);
  };

  const expectScrubbedHelmError = (failure: unknown, secret: string) => {
    expect(failure).toBeInstanceOf(HelmError);
    if (!(failure instanceof HelmError)) return;
    expect(failure.message).toContain("<redacted>");
    expect(failure.message).not.toContain(secret);
  };

  it.effect(
    "leaves credentials in successfully parsed objects",
    () =>
      Effect.gen(function* () {
        const secret = "helm-kept-secret";
        const objects = yield* parseRenderedManifests(
          "example",
          `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  token: ${secret}
`,
          [secret],
        );
        const configMap = objects[0] as { data?: { token?: string } };
        expect(configMap.data?.token).toBe(secret);
      }),
    { tags: parserTags },
  );

  it.effect(
    "scrubs credentials from invalid rendered documents",
    () =>
      Effect.gen(function* () {
        const secret = "helm-object-secret";
        expectScrubbedMessage(
          yield* Effect.result(parseRenderedManifests("example", `${secret}\n`, [secret])),
          secret,
          "non-object",
        );
        const missingVersion = yield* Effect.result(
          parseRenderedManifests(
            "example",
            `kind: ConfigMap
data:
  token: ${secret}
`,
            [secret],
          ),
        );
        expectScrubbedMessage(missingVersion, secret, "without apiVersion/kind");
        if (Result.isFailure(missingVersion)) {
          expect(missingVersion.failure.message).toContain("ConfigMap");
        }
        expectScrubbedMessage(
          yield* Effect.result(
            parseRenderedManifests(
              "example",
              `apiVersion: v1
kind: ${secret}
metadata: {}
`,
              [secret],
            ),
          ),
          secret,
          "without metadata.name",
        );
      }),
    { tags: parserTags },
  );

  it.effect(
    "scrubs a credential that crosses the diagnostic truncation boundary",
    () =>
      Effect.gen(function* () {
        // JSON is {"token":"<secret>"}; the secret starts at index 10 and
        // continues past the 200-character snippet, so slicing first would
        // leave a prefix that replaceAll cannot match.
        const secret = `boundary-secret-${"Z".repeat(240)}`;
        const result = yield* Effect.result(
          parseRenderedManifests("example", `token: ${secret}\n`, [secret]),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("without apiVersion/kind");
          expect(result.failure.message).toContain("<redacted>");
          expect(result.failure.message).not.toContain(secret);
          expect(result.failure.message).not.toContain(secret.slice(0, 40));
          expect(result.failure.message).not.toContain(secret.slice(20, 80));
        }
      }),
    { tags: parserTags },
  );

  it.effect(
    "returns a typed error for malformed YAML without the credential",
    () =>
      Effect.gen(function* () {
        const secret = "helm-yaml-secret";
        const parsed = yield* Effect.result(
          parseRenderedManifests("example", `token: "${secret}\n`, [secret]),
        );
        expect(Result.isFailure(parsed)).toBe(true);
        if (Result.isFailure(parsed)) {
          expectScrubbedHelmError(parsed.failure, secret);
          expect(parsed.failure.message).toContain("Failed to parse");
        }

        const alias = "helm-alias-secret";
        const thrown = yield* Effect.result(
          parseRenderedManifests("example", `*${alias}\n`, [alias]),
        );
        expect(Result.isFailure(thrown)).toBe(true);
        if (Result.isFailure(thrown)) {
          expectScrubbedHelmError(thrown.failure, alias);
          expect(thrown.failure.message).toContain("Failed to parse");
        }
      }),
    { tags: parserTags },
  );
});

// Ungated probe: chart objects live in-cluster with no cloud-side
// enumeration attributing them to alchemy, so `list()` is intentionally
// empty. Proves the provider is registered and its record type-checks; the
// live apply path rides the gated Deployment E2E cluster
// (Deployment.test.ts).
test.provider(
  "list returns an empty array (in-cluster objects)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.HelmChart);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:kubernetes", "provider:kubernetes:helmchart", "local"] },
);
