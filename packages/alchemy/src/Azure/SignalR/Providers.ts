import * as Layer from "effect/Layer";
import {
  CustomCertificate,
  CustomCertificateProvider,
} from "./CustomCertificate.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { Replica, ReplicaProvider } from "./Replica.ts";
import {
  ReplicaSharedPrivateLinkResource,
  ReplicaSharedPrivateLinkResourceProvider,
} from "./ReplicaSharedPrivateLinkResource.ts";
import {
  SharedPrivateLinkResource,
  SharedPrivateLinkResourceProvider,
} from "./SharedPrivateLinkResource.ts";
import { SignalR, SignalRProvider } from "./SignalR.ts";

export const resources = [
  CustomCertificate,
  CustomDomain,
  Replica,
  ReplicaSharedPrivateLinkResource,
  SharedPrivateLinkResource,
  SignalR,
];
export const layers = () =>
  Layer.mergeAll(
    CustomCertificateProvider(),
    CustomDomainProvider(),
    ReplicaProvider(),
    ReplicaSharedPrivateLinkResourceProvider(),
    SharedPrivateLinkResourceProvider(),
    SignalRProvider(),
  );
