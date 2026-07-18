import * as AWS from "@/AWS";
import { Manifest } from "@/AWS/EKS/Manifest.ts";
import * as Kubernetes from "@/Kubernetes/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// Ungated probe: `Manifest` applies in-cluster objects that have no AWS-side
// enumeration attributing them to alchemy, so `list()` is intentionally
// empty. The probe proves the provider is registered and its record
// type-checks. The full apply path shares the live-cluster budget problem of
// every EKS platform test (a control-plane create is ~15 min), so lifecycle
// coverage rides the gated Deployment E2E cluster rather than paying for its
// own; see Deployment.test.ts.
test.provider("list returns an empty array (in-cluster objects)", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Manifest);
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toEqual([]);
  }),
);

// The opt-in Kubernetes builders are zero-runtime typed constructors — assert
// they fill apiVersion/kind and pass everything else through untouched.
test(
  "Kubernetes builders fill apiVersion/kind",
  Effect.sync(() => {
    const sts = Kubernetes.statefulSet({
      metadata: { name: "cache", namespace: "apps" },
      spec: {
        serviceName: "cache",
        replicas: 3,
        selector: { matchLabels: { app: "cache" } },
        template: {
          metadata: { labels: { app: "cache" } },
          spec: { containers: [{ name: "redis", image: "redis:7" }] },
        },
      },
    });
    expect(sts.apiVersion).toBe("apps/v1");
    expect(sts.kind).toBe("StatefulSet");
    expect(sts.spec?.replicas).toBe(3);

    const ns = Kubernetes.namespace({ metadata: { name: "apps" } });
    expect(ns.apiVersion).toBe("v1");
    expect(ns.kind).toBe("Namespace");

    const cron = Kubernetes.cronJob({
      metadata: { name: "nightly", namespace: "apps" },
      spec: {
        schedule: "0 3 * * *",
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: "Never",
                containers: [{ name: "job", image: "busybox:1.36" }],
              },
            },
          },
        },
      },
    });
    expect(cron.apiVersion).toBe("batch/v1");
    expect(cron.kind).toBe("CronJob");
  }),
);
