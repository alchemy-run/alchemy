import * as Layer from "effect/Layer";
import { AttachedNetwork, AttachedNetworkProvider } from "./AttachedNetwork.ts";
import { Catalog, CatalogProvider } from "./Catalog.ts";
import {
  DevBoxDefinition,
  DevBoxDefinitionProvider,
} from "./DevBoxDefinition.ts";
import { DevCenter, DevCenterProvider } from "./DevCenter.ts";
import { EnvironmentType, EnvironmentTypeProvider } from "./EnvironmentType.ts";
import { Gallery, GalleryProvider } from "./Gallery.ts";
import {
  NetworkConnection,
  NetworkConnectionProvider,
} from "./NetworkConnection.ts";
import { Pool, PoolProvider } from "./Pool.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectCatalog, ProjectCatalogProvider } from "./ProjectCatalog.ts";
import {
  ProjectEnvironmentType,
  ProjectEnvironmentTypeProvider,
} from "./ProjectEnvironmentType.ts";
import { ProjectPolicy, ProjectPolicyProvider } from "./ProjectPolicy.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";

export const resources = [
  AttachedNetwork,
  Catalog,
  DevBoxDefinition,
  DevCenter,
  EnvironmentType,
  Gallery,
  NetworkConnection,
  Pool,
  Project,
  ProjectCatalog,
  ProjectEnvironmentType,
  ProjectPolicy,
  Schedule,
];
export const layers = () =>
  Layer.mergeAll(
    AttachedNetworkProvider(),
    CatalogProvider(),
    DevBoxDefinitionProvider(),
    DevCenterProvider(),
    EnvironmentTypeProvider(),
    GalleryProvider(),
    NetworkConnectionProvider(),
    PoolProvider(),
    ProjectProvider(),
    ProjectCatalogProvider(),
    ProjectEnvironmentTypeProvider(),
    ProjectPolicyProvider(),
    ScheduleProvider(),
  );
