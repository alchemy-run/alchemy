import * as AWSUI from "alchemy/AWS/UI";
import * as AxiomUI from "alchemy/Axiom/UI";
import * as CloudflareUI from "alchemy/Cloudflare/UI";
import * as DockerUI from "alchemy/Docker/UI";
import * as FlyUI from "alchemy/Fly/UI";
import * as GitHubUI from "alchemy/GitHub/UI";
import * as HetznerUI from "alchemy/Hetzner/UI";
import * as KubernetesUI from "alchemy/Kubernetes/UI";
import * as NeonUI from "alchemy/Neon/UI";
import * as PlanetscaleUI from "alchemy/Planetscale/UI";
import * as RailwayUI from "alchemy/Railway/UI";
import { buildRegistry, type UIRegistry } from "alchemy/UI/UIProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
        FlyUI.ui(),
        GitHubUI.ui(),
        HetznerUI.ui(),
        KubernetesUI.ui(),
        NeonUI.ui(),
        PlanetscaleUI.ui(),
        RailwayUI.ui(),
      ),
    ),
  );
