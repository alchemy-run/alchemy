import * as Layer from "effect/Layer";
import { AksAssessment, AksAssessmentProvider } from "./AksAssessment.ts";
import { Assessment, AssessmentProvider } from "./Assessment.ts";
import {
  AssessmentProject,
  AssessmentProjectProvider,
} from "./AssessmentProject.ts";
import { AvsAssessment, AvsAssessmentProvider } from "./AvsAssessment.ts";
import { Group, GroupProvider } from "./Group.ts";
import { HypervCluster, HypervClusterProvider } from "./HypervCluster.ts";
import { HypervCollector, HypervCollectorProvider } from "./HypervCollector.ts";
import { HypervHost, HypervHostProvider } from "./HypervHost.ts";
import { HypervSite, HypervSiteProvider } from "./HypervSite.ts";
import { ImportCollector, ImportCollectorProvider } from "./ImportCollector.ts";
import { ImportSite, ImportSiteProvider } from "./ImportSite.ts";
import { MasterSite, MasterSiteProvider } from "./MasterSite.ts";
import { MigrateProject, MigrateProjectProvider } from "./MigrateProject.ts";
import { ServerCollector, ServerCollectorProvider } from "./ServerCollector.ts";
import { ServerSite, ServerSiteProvider } from "./ServerSite.ts";
import { Solution, SolutionProvider } from "./Solution.ts";
import { SqlAssessment, SqlAssessmentProvider } from "./SqlAssessment.ts";
import { SqlCollector, SqlCollectorProvider } from "./SqlCollector.ts";
import { Vcenter, VcenterProvider } from "./Vcenter.ts";
import { VmwareCollector, VmwareCollectorProvider } from "./VmwareCollector.ts";
import { VmwareSite, VmwareSiteProvider } from "./VmwareSite.ts";
import {
  WebAppAssessment,
  WebAppAssessmentProvider,
} from "./WebAppAssessment.ts";
import { WebAppCollector, WebAppCollectorProvider } from "./WebAppCollector.ts";

export const resources = [
  AksAssessment,
  Assessment,
  AssessmentProject,
  AvsAssessment,
  Group,
  HypervCluster,
  HypervCollector,
  HypervHost,
  HypervSite,
  ImportCollector,
  ImportSite,
  MasterSite,
  MigrateProject,
  ServerCollector,
  ServerSite,
  Solution,
  SqlAssessment,
  SqlCollector,
  Vcenter,
  VmwareCollector,
  VmwareSite,
  WebAppAssessment,
  WebAppCollector,
];
export const layers = () =>
  Layer.mergeAll(
    AksAssessmentProvider(),
    AssessmentProvider(),
    AssessmentProjectProvider(),
    AvsAssessmentProvider(),
    GroupProvider(),
    HypervClusterProvider(),
    HypervCollectorProvider(),
    HypervHostProvider(),
    HypervSiteProvider(),
    ImportCollectorProvider(),
    ImportSiteProvider(),
    MasterSiteProvider(),
    MigrateProjectProvider(),
    ServerCollectorProvider(),
    ServerSiteProvider(),
    SolutionProvider(),
    SqlAssessmentProvider(),
    SqlCollectorProvider(),
    VcenterProvider(),
    VmwareCollectorProvider(),
    VmwareSiteProvider(),
    WebAppAssessmentProvider(),
    WebAppCollectorProvider(),
  );
