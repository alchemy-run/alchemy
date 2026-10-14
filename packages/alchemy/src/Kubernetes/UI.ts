import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Connection } from "./Connection.ts";
import type { HelmChart } from "./HelmChart.ts";
import type { Manifest } from "./Manifest.ts";

/**
 * Dashboard UI providers for cluster-agnostic Kubernetes resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Kubernetes client code reaches the dashboard bundle.
 */

/** API server host a workload was applied to. */
const endpointOf = (connection: Connection | undefined): string | undefined => {
  const endpoint = connection?.endpoint;
  if (endpoint === undefined) {
    return undefined;
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
};

export const HelmChartUI = UIProvider.succeed<HelmChart>(
  "Kubernetes.HelmChart",
  {
    displayName: "Helm Chart",
    icon: "package",
    // Kubernetes blue rather than the AWS orange these carried while they
    // lived under EKS — they now target any cluster, not just EKS.
    color: "#326CE5",
    category: "config",
    summary: (ctx) => ctx.attrs?.releaseName,
    facts: (ctx) => [
      { label: "release", value: ctx.attrs?.releaseName, copy: true },
      { label: "namespace", value: ctx.attrs?.namespace },
      { label: "chart", value: ctx.attrs?.chart, mono: true },
      { label: "version", value: ctx.attrs?.version },
      {
        label: "cluster",
        value: endpointOf(ctx.attrs?.connection),
        mono: true,
      },
      { label: "auth", value: ctx.attrs?.connection?.auth?.kind },
      { label: "objects", value: ctx.attrs?.objects?.length },
      { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
    ],
  },
);

export const ManifestUI = UIProvider.succeed<Manifest>("Kubernetes.Manifest", {
  displayName: "Kubernetes Manifest",
  icon: "file-text",
  color: "#326CE5",
  category: "config",
  summary: (ctx) =>
    ctx.attrs?.kind === undefined
      ? ctx.attrs?.name
      : `${ctx.attrs.kind}/${ctx.attrs.name}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "kind", value: ctx.attrs?.kind },
    { label: "api version", value: ctx.attrs?.apiVersion, mono: true },
    { label: "namespace", value: ctx.attrs?.namespace },
    { label: "cluster", value: endpointOf(ctx.attrs?.connection), mono: true },
    { label: "auth", value: ctx.attrs?.connection?.auth?.kind },
    { label: "uid", value: ctx.attrs?.uid, mono: true, copy: true },
  ],
});

export const ui = () => Layer.mergeAll(HelmChartUI, ManifestUI);
