import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Container } from "./Container.ts";
import type { Context } from "./Context.ts";
import type { Image } from "./Image.ts";
import type { Network } from "./Network.ts";
import type { RemoteImage } from "./RemoteImage.ts";
import type { Swarm } from "./Swarm.ts";
import type { Volume } from "./Volume.ts";

/**
 * Dashboard UI providers for Docker resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Docker CLI code reaches the dashboard bundle.
 */

const DOCKER_BLUE = "#2496ED";

export const ContainerUI = UIProvider.succeed<Container>("Docker.Container", {
  displayName: "Docker Container",
  icon: "container",
  color: DOCKER_BLUE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "image", value: ctx.attrs?.imageRef, mono: true, copy: true },
    {
      label: "ports",
      value: ctx.attrs?.ports
        ? Object.entries(ctx.attrs.ports)
            .map(([internal, external]) => `${external}->${internal}`)
            .join(", ") || undefined
        : undefined,
      mono: true,
    },
    { label: "restart", value: ctx.props?.restart },
  ],
});

export const ImageUI = UIProvider.succeed<Image>("Docker.Image", {
  displayName: "Docker Image",
  icon: "package",
  color: DOCKER_BLUE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.imageRef,
  facts: (ctx) => [
    { label: "ref", value: ctx.attrs?.imageRef, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name },
    { label: "tag", value: ctx.attrs?.tag, mono: true },
    { label: "image id", value: ctx.attrs?.imageId, mono: true, copy: true },
    { label: "digest", value: ctx.attrs?.repoDigest, mono: true, copy: true },
    { label: "context", value: ctx.props?.build?.context, mono: true },
    { label: "registry", value: ctx.props?.registry?.server },
  ],
});

export const RemoteImageUI = UIProvider.succeed<RemoteImage>(
  "Docker.RemoteImage",
  {
    displayName: "Docker Remote Image",
    icon: "cloud-download",
    color: DOCKER_BLUE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.imageRef,
    facts: (ctx) => [
      { label: "ref", value: ctx.attrs?.imageRef, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "tag", value: ctx.attrs?.tag, mono: true },
      { label: "image id", value: ctx.attrs?.imageId, mono: true, copy: true },
      { label: "digest", value: ctx.attrs?.repoDigest, mono: true, copy: true },
      { label: "platform", value: ctx.props?.platform },
      { label: "registry", value: ctx.props?.registry?.server },
    ],
  },
);

export const NetworkUI = UIProvider.succeed<Network>("Docker.Network", {
  displayName: "Docker Network",
  icon: "network",
  color: DOCKER_BLUE,
  category: "network",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "driver", value: ctx.attrs?.driver },
    { label: "ipv6", value: ctx.attrs?.enableIPv6 },
  ],
});

export const VolumeUI = UIProvider.succeed<Volume>("Docker.Volume", {
  displayName: "Docker Volume",
  icon: "hard-drive",
  color: DOCKER_BLUE,
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "driver", value: ctx.attrs?.driver },
    {
      label: "mountpoint",
      value: ctx.attrs?.mountpoint,
      mono: true,
      copy: true,
    },
  ],
});

export const ContextUI = UIProvider.succeed<Context>("Docker.Context", {
  displayName: "Docker Context",
  icon: "waypoints",
  color: DOCKER_BLUE,
  category: "config",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "endpoint", value: ctx.attrs?.docker, mono: true, copy: true },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const SwarmUI = UIProvider.succeed<Swarm>("Docker.Swarm", {
  displayName: "Docker Swarm",
  icon: "boxes",
  color: DOCKER_BLUE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.id,
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "node", value: ctx.attrs?.nodeId, mono: true },
    { label: "context", value: ctx.attrs?.context },
    { label: "managers", value: ctx.attrs?.managers },
    { label: "nodes", value: ctx.attrs?.nodes },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ContainerUI,
    ContextUI,
    ImageUI,
    RemoteImageUI,
    NetworkUI,
    SwarmUI,
    VolumeUI,
  );
