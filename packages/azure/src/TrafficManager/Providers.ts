import * as Layer from "effect/Layer";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { Profile, ProfileProvider } from "./Profile.ts";
import { UserMetricsKey, UserMetricsKeyProvider } from "./UserMetricsKey.ts";

export const resources = [Endpoint, Profile, UserMetricsKey];
export const layers = () =>
  Layer.mergeAll(EndpointProvider(), ProfileProvider(), UserMetricsKeyProvider());
