import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Container, ContainerProvider } from "./Container.ts";
import { Context, ContextProvider } from "./Context.ts";
import { DockerLive } from "./Docker.ts";
import { Image, ImageProvider } from "./Image.ts";
import { Network, NetworkProvider } from "./Network.ts";
import { RemoteImage, RemoteImageProvider } from "./RemoteImage.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { Swarm, SwarmProvider } from "./Swarm.ts";
import { Volume, VolumeProvider } from "./Volume.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Docker",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/** Shared image provider layers for container-platform integrations. */
export const imageProviders = Layer.mergeAll(
  ImageProvider(),
  RemoteImageProvider(),
);

/**
 * Registers all Docker resource providers.
 *
 * Docker providers use the active Docker CLI context and are intentionally
 * separate from `Cloudflare.Container`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Container,
      Image,
      Network,
      RemoteImage,
      Volume,
      Context,
      Service,
      Swarm,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ContainerProvider(),
        imageProviders,
        NetworkProvider(),
        VolumeProvider(),
        ContextProvider(),
        ServiceProvider(),
        SwarmProvider(),
      ),
    ),
    Layer.provideMerge(DockerLive),
  );
