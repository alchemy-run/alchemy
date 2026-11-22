import * as Layer from "effect/Layer";
import { AfdCustomDomain, AfdCustomDomainProvider } from "./AfdCustomDomain.ts";
import { AfdEndpoint, AfdEndpointProvider } from "./AfdEndpoint.ts";
import { AfdOrigin, AfdOriginProvider } from "./AfdOrigin.ts";
import { AfdOriginGroup, AfdOriginGroupProvider } from "./AfdOriginGroup.ts";
import { Profile, ProfileProvider } from "./Profile.ts";
import { Route, RouteProvider } from "./Route.ts";
import { Rule, RuleProvider } from "./Rule.ts";
import { RuleSet, RuleSetProvider } from "./RuleSet.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { SecurityPolicy, SecurityPolicyProvider } from "./SecurityPolicy.ts";

export const resources = [
  AfdCustomDomain,
  AfdEndpoint,
  AfdOrigin,
  AfdOriginGroup,
  Profile,
  Route,
  Rule,
  RuleSet,
  Secret,
  SecurityPolicy,
];
export const layers = () =>
  Layer.mergeAll(
    AfdCustomDomainProvider(),
    AfdEndpointProvider(),
    AfdOriginProvider(),
    AfdOriginGroupProvider(),
    ProfileProvider(),
    RouteProvider(),
    RuleProvider(),
    RuleSetProvider(),
    SecretProvider(),
    SecurityPolicyProvider(),
  );
