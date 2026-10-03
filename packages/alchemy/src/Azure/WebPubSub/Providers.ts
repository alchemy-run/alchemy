import * as Layer from "effect/Layer";
import {
  CustomCertificate,
  CustomCertificateProvider,
} from "./CustomCertificate.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { Hub, HubProvider } from "./Hub.ts";
import { Replica, ReplicaProvider } from "./Replica.ts";
import {
  ReplicaSharedPrivateLinkResource,
  ReplicaSharedPrivateLinkResourceProvider,
} from "./ReplicaSharedPrivateLinkResource.ts";
import {
  SharedPrivateLinkResource,
  SharedPrivateLinkResourceProvider,
} from "./SharedPrivateLinkResource.ts";
import { WebPubSub, WebPubSubProvider } from "./WebPubSub.ts";

export const resources = [
  CustomCertificate,
  CustomDomain,
  Hub,
  Replica,
  ReplicaSharedPrivateLinkResource,
  SharedPrivateLinkResource,
  WebPubSub,
];
export const layers = () =>
  Layer.mergeAll(
    CustomCertificateProvider(),
    CustomDomainProvider(),
    HubProvider(),
    ReplicaProvider(),
    ReplicaSharedPrivateLinkResourceProvider(),
    SharedPrivateLinkResourceProvider(),
    WebPubSubProvider(),
  );
