import * as Layer from "effect/Layer";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { Connector, ConnectorProvider } from "./Connector.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Organization, OrganizationProvider } from "./Organization.ts";
import { Topic, TopicProvider } from "./Topic.ts";

export const resources = [Cluster, Connector, Environment, Organization, Topic];
export const layers = () =>
  Layer.mergeAll(
    ClusterProvider(),
    ConnectorProvider(),
    EnvironmentProvider(),
    OrganizationProvider(),
    TopicProvider(),
  );
