import * as AWSUI from "alchemy/AWS/UI";
import * as AxiomUI from "alchemy/Axiom/UI";
import * as CloudflareUI from "alchemy/Cloudflare/UI";
import * as DockerUI from "alchemy/Docker/UI";
import * as GitHubUI from "alchemy/GitHub/UI";
import * as KubernetesUI from "alchemy/Kubernetes/UI";
import * as NeonUI from "alchemy/Neon/UI";
import * as PlanetscaleUI from "alchemy/Planetscale/UI";
import {
  buildRegistry,
  type ResourceUIContext,
  type UIRegistry,
} from "alchemy/UI/UIProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DashboardMeta, DashboardNode } from "./types.ts";

/**
 * Build the UI registry from every cloud's aggregated UI layer. This is the
 * single place a new cloud provider is wired into the dashboard.
 */
export const loadRegistry = (): Promise<UIRegistry> =>
  Effect.runPromise(
    buildRegistry(
      Layer.mergeAll(
        AWSUI.ui(),
        AxiomUI.ui(),
        CloudflareUI.ui(),
        DockerUI.ui(),
        GitHubUI.ui(),
        KubernetesUI.ui(),
        NeonUI.ui(),
        PlanetscaleUI.ui(),
      ),
    ),
  );

export const toCtx = (
  node: DashboardNode,
  meta: DashboardMeta,
): ResourceUIContext => ({
  fqn: node.fqn,
  logicalId: node.logicalId,
  type: node.type,
  status: node.status as ResourceUIContext["status"],
  stack: meta.stack,
  stage: meta.stage,
  props: node.props,
  attrs: node.attrs,
  bindings: node.bindings,
  downstream: node.downstream,
});
