import * as Layer from "effect/Layer";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { Profile, ProfileProvider } from "./Profile.ts";

export const resources = [Endpoint, Profile];
export const layers = () =>
  Layer.mergeAll(EndpointProvider(), ProfileProvider());
