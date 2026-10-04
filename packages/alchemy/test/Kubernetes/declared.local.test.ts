import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Kubernetes from "@/Kubernetes";
import {
  appliedObjectsMatch,
  driftMask,
  hashDriftSelection,
} from "@/Kubernetes/internal/declared.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({
  providers: Layer.mergeAll(Kubernetes.providers(), NodeServices.layer),
});

test(
  "declared lists with a merge key compare by that key",
  Effect.sync(() => {
    const desired = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "a", image: "a:1" },
              { name: "b", image: "b:1" },
            ],
          },
        },
      },
    };
    const preview = {
      ...desired,
      metadata: { name: "app", uid: "u", resourceVersion: "9" },
    };
    const reordered = {
      ...preview,
      spec: {
        template: {
          spec: {
            containers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
      },
    };
    expect(appliedObjectsMatch(reordered, preview, desired)).toBe(true);
    const edited = {
      ...reordered,
      spec: {
        template: {
          spec: {
            containers: [
              { name: "b", image: "b:2" },
              { name: "a", image: "a:1" },
            ],
          },
        },
      },
    };
    expect(appliedObjectsMatch(edited, preview, desired)).toBe(false);
    const tolerations = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "app" },
      spec: {
        tolerations: [
          {
            key: "disk",
            operator: "Equal",
            value: "ssd",
            effect: "NoSchedule",
          },
          { key: "disk", operator: "Exists", effect: "NoExecute" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...tolerations,
          spec: {
            tolerations: [
              { key: "disk", operator: "Exists", effect: "NoExecute" },
              {
                key: "disk",
                operator: "Equal",
                value: "ssd",
                effect: "NoSchedule",
              },
            ],
          },
        },
        tolerations,
        tolerations,
      ),
    ).toBe(true);
    expect(
      appliedObjectsMatch(
        {
          ...tolerations,
          spec: {
            tolerations: [
              {
                key: "disk",
                operator: "Equal",
                value: "ssd",
                effect: "NoExecute",
              },
              { key: "disk", operator: "Exists", effect: "NoExecute" },
            ],
          },
        },
        tolerations,
        tolerations,
      ),
    ).toBe(false);
    const bare = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "app" },
      spec: { tolerations: [{ key: "gpu" }] },
    };
    const defaulted = {
      ...bare,
      spec: { tolerations: [{ key: "gpu", operator: "Equal" }] },
    };
    expect(appliedObjectsMatch(defaulted, defaulted, bare)).toBe(true);
    expect(
      appliedObjectsMatch(
        {
          ...bare,
          spec: { tolerations: [{ key: "tpu", operator: "Equal" }] },
        },
        defaulted,
        bare,
      ),
    ).toBe(false);
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "app" },
      spec: {
        ports: [
          { name: "http", port: 80 },
          { name: "https", port: 443 },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...service,
          spec: {
            ports: [
              { name: "https", port: 443 },
              { name: "http", port: 80 },
            ],
          },
        },
        service,
        service,
      ),
    ).toBe(true);
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "token" },
      stringData: Redacted.make({ token: "s3cr3t" }),
    };
    const encode = (value: string) => Buffer.from(value).toString("base64");
    expect(JSON.stringify(driftMask(secret))).not.toContain("s3cr3t");
    expect(
      appliedObjectsMatch(
        {
          ...secret,
          stringData: undefined,
          data: { token: encode("s3cr3t"), extra: encode("other-value") },
        },
        {
          ...secret,
          stringData: undefined,
          data: { token: encode("s3cr3t") },
        },
        secret,
      ),
    ).toBe(true);
    const indexed = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "c" },
      data: { items: ["a", "b"] },
    };
    expect(appliedObjectsMatch({ ...indexed, data: { items: ["b", "a"] } }, indexed, indexed)).toBe(
      false,
    );
    expect(
      appliedObjectsMatch({ ...indexed, data: { items: ["a", "b", "c"] } }, indexed, indexed),
    ).toBe(false);
    const named = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: {
        items: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...named,
          spec: {
            items: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
        named,
        named,
      ),
    ).toBe(false);
    const settings = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { settings: { a: 1 } },
    };
    // Undeclared map keys are not part of the selection.
    expect(
      appliedObjectsMatch({ ...settings, spec: { settings: { a: 1, b: 2 } } }, settings, settings),
    ).toBe(true);
    expect(
      appliedObjectsMatch({ ...settings, spec: { settings: { a: 2 } } }, settings, settings),
    ).toBe(false);
  }),
  { tags: ["provider:kubernetes", "local"] },
);

type DriftMeta = {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uid?: string;
  resourceVersion?: string;
};

type DriftDeployment = {
  apiVersion: string;
  kind: string;
  metadata: DriftMeta;
  spec: {
    replicas?: number;
    revisionHistoryLimit?: number;
    selector?: { matchLabels: Record<string, string> };
    template: { metadata: DriftMeta; spec: Record<string, unknown> };
  };
};

const deployment = (name: string, spec: DriftDeployment["spec"]): DriftDeployment => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace: "default" },
  spec,
});

const podSpec = (spec: Record<string, unknown>): DriftDeployment["spec"] => ({
  selector: { matchLabels: { app: "web" } },
  template: { metadata: { labels: { app: "web" } }, spec },
});

test(
  "drift selection keeps declared fields and ignores server-owned ones",
  Effect.gen(function* () {
    const declared = deployment("app", {
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    const canonical = {
      ...declared,
      metadata: { ...declared.metadata, uid: "u", resourceVersion: "1" },
      spec: {
        replicas: 1,
        revisionHistoryLimit: 10,
        ...declared.spec,
        template: {
          ...declared.spec.template,
          spec: {
            containers: [{ name: "app", image: "app:1", imagePullPolicy: "IfNotPresent" }],
          },
        },
      },
    };
    const mask = driftMask(declared);
    const baseline = yield* hashDriftSelection(declared, canonical);
    expect(yield* hashDriftSelection(mask, canonical)).toBe(baseline);
    // Older state has no canonical hash. The same selection against the
    // declaration ignores apiserver defaults.
    expect(yield* hashDriftSelection(mask, declared)).toBe(
      yield* hashDriftSelection(mask, canonical),
    );
    const resized = { ...canonical, spec: { ...canonical.spec, replicas: 5 } };
    expect(yield* hashDriftSelection(mask, resized)).toBe(baseline);

    const pinned = deployment("pinned", {
      replicas: 2,
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    const pinnedMask = driftMask(pinned);
    const pinnedBaseline = yield* hashDriftSelection(pinned, pinned);
    expect(
      yield* hashDriftSelection(pinnedMask, { ...pinned, spec: { ...pinned.spec, replicas: 3 } }),
    ).not.toBe(pinnedBaseline);

    const noted = deployment("noted", {
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    noted.metadata = {
      ...noted.metadata,
      annotations: { app: "web" },
    };
    (
      noted.spec.template as {
        metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
      }
    ).metadata = {
      labels: { app: "web" },
      annotations: { "prometheus.io/scrape": "true" },
    };
    const notedMask = driftMask(noted);
    const notedBaseline = yield* hashDriftSelection(noted, noted);
    const controller = {
      ...noted,
      metadata: {
        ...noted.metadata,
        annotations: { app: "web", "deployment.kubernetes.io/revision": "4" },
      },
    };
    expect(yield* hashDriftSelection(notedMask, controller)).toBe(notedBaseline);
    const edited = {
      ...noted,
      metadata: { ...noted.metadata, annotations: { app: "api" } },
    };
    expect(yield* hashDriftSelection(notedMask, edited)).not.toBe(notedBaseline);
    const dropped = {
      ...noted,
      metadata: { ...noted.metadata, annotations: {} },
    };
    expect(yield* hashDriftSelection(notedMask, dropped)).not.toBe(notedBaseline);
    const template = noted.spec.template as {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: unknown;
    };
    const templateEdited = {
      ...noted,
      spec: {
        ...noted.spec,
        template: {
          ...template,
          metadata: { ...template.metadata, annotations: { "prometheus.io/scrape": "false" } },
        },
      },
    };
    expect(yield* hashDriftSelection(notedMask, templateEdited)).not.toBe(notedBaseline);
    const templateDropped = {
      ...noted,
      spec: {
        ...noted.spec,
        template: { ...template, metadata: { labels: { app: "web" } } },
      },
    };
    expect(yield* hashDriftSelection(notedMask, templateDropped)).not.toBe(notedBaseline);

    const ordered = deployment("ordered", {
      ...podSpec({
        initContainers: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
        containers: [
          { name: "app", image: "app:1" },
          { name: "sidecar", image: "sidecar:1" },
        ],
      }),
    });
    const orderedMask = driftMask(ordered);
    const orderedBaseline = yield* hashDriftSelection(ordered, ordered);
    const reversedInit = {
      ...ordered,
      spec: {
        ...ordered.spec,
        template: {
          ...ordered.spec.template,
          spec: {
            initContainers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
            containers: [
              { name: "sidecar", image: "sidecar:1" },
              { name: "app", image: "app:1" },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(orderedMask, reversedInit)).not.toBe(orderedBaseline);
    const reversedContainers = {
      ...ordered,
      spec: {
        ...ordered.spec,
        template: {
          ...ordered.spec.template,
          spec: {
            initContainers: [
              { name: "a", image: "a:1" },
              { name: "b", image: "b:1" },
            ],
            containers: [
              { name: "sidecar", image: "sidecar:1" },
              { name: "app", image: "app:1" },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(orderedMask, reversedContainers)).toBe(orderedBaseline);

    const dns = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "dns" },
      spec: {
        ports: [
          { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
          { name: "dns-udp", port: 53, protocol: "UDP", targetPort: 53 },
        ],
      },
    };
    const dnsMask = driftMask(dns);
    const dnsBaseline = yield* hashDriftSelection(dns, dns);
    expect(yield* hashDriftSelection(dnsMask, dns)).toBe(dnsBaseline);
    const udpEdited = {
      ...dns,
      spec: {
        ports: [dns.spec.ports[0], { ...dns.spec.ports[1], targetPort: 5353 }],
      },
    };
    expect(yield* hashDriftSelection(dnsMask, udpEdited)).not.toBe(dnsBaseline);
    const http = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "http" },
      spec: { ports: [{ port: 80, targetPort: 80 }] },
    };
    expect(
      yield* hashDriftSelection(driftMask(http), {
        ...http,
        spec: { ports: [{ port: 80, protocol: "TCP", targetPort: 80 }] },
      }),
    ).toBe(yield* hashDriftSelection(http, http));
    const probed = deployment("probed", {
      ...podSpec({
        containers: [
          {
            name: "app",
            image: "app:1",
            ports: [
              { name: "dns-tcp", containerPort: 53, protocol: "TCP", hostPort: 53 },
              { name: "dns-udp", containerPort: 53, protocol: "UDP", hostPort: 53 },
            ],
          },
        ],
      }),
    });
    const probedMask = driftMask(probed);
    const probedBaseline = yield* hashDriftSelection(probed, probed);
    const probedSpec = probed.spec.template as unknown as {
      spec: { containers: Array<{ ports: Array<Record<string, unknown>> }> };
    };
    const probedEdited = {
      ...probed,
      spec: {
        ...probed.spec,
        template: {
          ...probed.spec.template,
          spec: {
            containers: [
              {
                ...probedSpec.spec.containers[0],
                ports: [
                  probedSpec.spec.containers[0]!.ports[0],
                  { ...probedSpec.spec.containers[0]!.ports[1], hostPort: 5353 },
                ],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(probedMask, probedEdited)).not.toBe(probedBaseline);

    const namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "team",
        finalizers: ["example.com/keep", "example.com/other"],
      },
    };
    const namespaceMask = driftMask(namespace);
    const namespaceBaseline = yield* hashDriftSelection(namespace, namespace);
    expect(yield* hashDriftSelection(namespaceMask, namespace)).toBe(namespaceBaseline);
    expect(
      yield* hashDriftSelection(namespaceMask, {
        ...namespace,
        metadata: {
          ...namespace.metadata,
          finalizers: ["kubernetes", "example.com/other", "example.com/keep"],
        },
      }),
    ).toBe(namespaceBaseline);
    expect(
      yield* hashDriftSelection(namespaceMask, {
        ...namespace,
        metadata: {
          ...namespace.metadata,
          finalizers: ["kubernetes", "example.com/other"],
        },
      }),
    ).not.toBe(namespaceBaseline);

    const sized = deployment("sized", {
      ...podSpec({
        containers: [
          {
            name: "app",
            image: "app:1",
            resources: { requests: { cpu: "0.1", memory: "1.5Gi" } },
            ports: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      }),
    });
    const sizedMask = driftMask(sized);
    const sizedLive = {
      ...sized,
      spec: {
        ...sized.spec,
        template: {
          ...sized.spec.template,
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1",
                resources: { requests: { cpu: "100m", memory: "1536Mi" } },
                ports: [{ containerPort: 80, protocol: "TCP" }],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(sizedMask, sizedLive)).toBe(
      yield* hashDriftSelection(sizedMask, sized),
    );
    const resizedCpu = {
      ...sizedLive,
      spec: {
        ...sizedLive.spec,
        template: {
          ...sizedLive.spec.template,
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1",
                resources: { requests: { cpu: "200m", memory: "1536Mi" } },
                ports: [{ containerPort: 80, protocol: "TCP" }],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(sizedMask, resizedCpu)).not.toBe(
      yield* hashDriftSelection(sizedMask, sized),
    );

    const claim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "data" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1.5Gi" } },
      },
    };
    const claimLive = {
      ...claim,
      spec: {
        ...claim.spec,
        resources: { requests: { storage: "1536Mi" } },
      },
    };
    expect(yield* hashDriftSelection(driftMask(claim), claimLive)).toBe(
      yield* hashDriftSelection(driftMask(claim), claim),
    );

    const quota = {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "team" },
      spec: {
        hard: {
          "requests.cpu": "0.1",
          "limits.memory": "1.5Gi",
          "requests.storage": "1.5Gi",
        },
      },
    };
    expect(
      yield* hashDriftSelection(driftMask(quota), {
        ...quota,
        spec: {
          hard: {
            "requests.cpu": "100m",
            "limits.memory": "1536Mi",
            "requests.storage": "1536Mi",
          },
        },
      }),
    ).toBe(yield* hashDriftSelection(driftMask(quota), quota));

    const config = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "cfg" },
      data: { memory: "1Gi", cpu: "1", protocol: "tcp" },
    };
    expect(
      yield* hashDriftSelection(driftMask(config), {
        ...config,
        data: { memory: "1024Mi", cpu: "1000m", protocol: "TCP" },
      }),
    ).not.toBe(yield* hashDriftSelection(driftMask(config), config));
  }),
  { tags: ["provider:kubernetes", "local"] },
);
