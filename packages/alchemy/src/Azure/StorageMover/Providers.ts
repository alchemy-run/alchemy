import * as Layer from "effect/Layer";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { JobDefinition, JobDefinitionProvider } from "./JobDefinition.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { StorageMover, StorageMoverProvider } from "./StorageMover.ts";

export const resources = [
  Connection,
  Endpoint,
  JobDefinition,
  Project,
  StorageMover,
];
export const layers = () =>
  Layer.mergeAll(
    ConnectionProvider(),
    EndpointProvider(),
    JobDefinitionProvider(),
    ProjectProvider(),
    StorageMoverProvider(),
  );
