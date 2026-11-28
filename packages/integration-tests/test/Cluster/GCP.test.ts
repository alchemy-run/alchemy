import * as Cluster from "@alchemy.run/effect-cluster";
import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "./conformance.ts";
import Front from "./fixtures/gcp/front.ts";
import { Lives } from "./fixtures/gcp/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterGcp", import.meta.url);

let baseUrl = "";

/** Out-of-band reads run with the GCP credentials and project the stack deploys with. */
const gcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

/** Every Compute Engine instance the stack deployed, from its state. */
const instances = Effect.gen(function* () {
  const state = yield* yield* State.State;
  const at = { stack: sharedStack.name, stage: sharedStack.stage };
  const found: Array<{ project: string; zone: string; instanceName: string }> = [];
  for (const fqn of yield* state.list(at)) {
    const row = yield* state.get({ ...at, fqn });
    if (State.isResourceState(row) && row.resourceType === "GCP.Compute.Instance" && row.attr) {
      found.push(row.attr as { project: string; zone: string; instanceName: string });
    }
  }
  return found;
}).pipe(Effect.provide(sharedStack.state));

/** The value of a secret version named in an instance's metadata. */
const readVersion = (version: string) =>
  secretmanager
    .accessProjectsSecretsVersions({ name: version })
    .pipe(Effect.map((res) => Buffer.from(res.payload?.data ?? "", "base64").toString("utf8")));

// The Effect Cluster conformance cases, against Postgres and runners on
// Compute Engine, called from a Cloud Run service through the public gateways.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on GCP (Compute Engine)",
  { tags: ["provider:cluster", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.uri };
          }).pipe(Effect.provide(Lives)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl);
      }),
      { timeout: 1_800_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 1_200_000 });

    test(
      "instance metadata names the database password, URL and gateway token, never holds them",
      gcp(
        Effect.gen(function* () {
          const deployed = yield* instances;
          // Postgres, two Default runners and one Legacy runner.
          expect(deployed).toHaveLength(4);
          const secretKeys = new Set<string>();
          let runners = 0;
          let databases = 0;
          for (const { project, zone, instanceName } of deployed) {
            const instance = yield* compute.getInstances({ project, zone, instance: instanceName });
            const metadata = Object.fromEntries(
              (instance.metadata?.items ?? []).map((item) => [item.key ?? "", item.value ?? ""]),
            );
            const text = JSON.stringify(metadata);
            // No packed Redacted value anywhere.
            expect(text).not.toContain('\\"_tag\\":\\"Redacted\\"');
            const refs: Array<readonly [string, string]> = [];
            if (metadata["cluster-postgres-password"] !== undefined) {
              databases++;
              refs.push(["POSTGRES_PASSWORD", metadata["cluster-postgres-password"]]);
            } else {
              runners++;
              const env = metadata["cluster-runner-env"] ?? "";
              expect(env).not.toContain("CLUSTER_DATABASE_URL=");
              expect(env).not.toContain("CLUSTER_GATEWAY_TOKEN=");
              for (const line of (metadata["cluster-runner-secrets"] ?? "").split("\n")) {
                const at = line.indexOf("=");
                refs.push([line.slice(0, at), line.slice(at + 1)]);
              }
              expect(refs.map(([name]) => name).sort()).toEqual([
                "CLUSTER_DATABASE_URL",
                "CLUSTER_GATEWAY_TOKEN",
                "CLUSTER_SECRET_ENV",
              ]);
            }
            for (const [name, version] of refs) {
              // Only a reference, pinned to a version.
              expect(version).toMatch(/^projects\/[^/]+\/secrets\/[^/]+\/versions\/\d+$/);
              const value = yield* readVersion(version);
              // Neither the value, nor the password inside the URL, nor
              // any secret in the JSON object of the rest.
              const pieces =
                name === "CLUSTER_DATABASE_URL"
                  ? [value, decodeURIComponent(new URL(value).password)]
                  : name === "CLUSTER_SECRET_ENV"
                    ? Object.values(JSON.parse(value) as Record<string, string>).map(
                        (packed) => (JSON.parse(packed) as { value: string }).value,
                      )
                    : [value];
              if (name === "CLUSTER_SECRET_ENV") {
                for (const key of Object.keys(JSON.parse(value))) secretKeys.add(key);
              }
              for (const piece of pieces) {
                expect(piece.length).toBeGreaterThan(8);
                expect(text).not.toContain(piece);
              }
            }
          }
          expect(databases).toBe(1);
          expect(runners).toBe(3);
          // Runners call Counter and Journal, whose gateway tokens they hold.
          expect([...secretKeys].sort()).toEqual(
            expect.arrayContaining(["CLUSTER_Counter_TOKEN", "CLUSTER_Journal_TOKEN"]),
          );
        }),
      ),
      { timeout: 120_000 },
    );

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);
