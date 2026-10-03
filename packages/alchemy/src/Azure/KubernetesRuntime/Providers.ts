import * as Layer from "effect/Layer";
import { BgpPeer, BgpPeerProvider } from "./BgpPeer.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { StorageClass, StorageClassProvider } from "./StorageClass.ts";

export const resources = [BgpPeer, LoadBalancer, Service, StorageClass];
export const layers = () =>
  Layer.mergeAll(
    BgpPeerProvider(),
    LoadBalancerProvider(),
    ServiceProvider(),
    StorageClassProvider(),
  );
