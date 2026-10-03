import * as Layer from "effect/Layer";
import {
  WebApplicationFirewallPolicy,
  WebApplicationFirewallPolicyProvider,
} from "./WebApplicationFirewallPolicy.ts";

export const resources = [WebApplicationFirewallPolicy];
export const layers = () =>
  Layer.mergeAll(WebApplicationFirewallPolicyProvider());
