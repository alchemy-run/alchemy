import * as Layer from "effect/Layer";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { ManagementLock, ManagementLockProvider } from "./ManagementLock.ts";
import { ResourceGroup, ResourceGroupProvider } from "./ResourceGroup.ts";
import { ResourceLink, ResourceLinkProvider } from "./ResourceLink.ts";
import { TemplateSpec, TemplateSpecProvider } from "./TemplateSpec.ts";
import {
  TemplateSpecVersion,
  TemplateSpecVersionProvider,
} from "./TemplateSpecVersion.ts";

export const resources = [
  Deployment,
  ManagementLock,
  ResourceGroup,
  ResourceLink,
  TemplateSpec,
  TemplateSpecVersion,
];
export const layers = () =>
  Layer.mergeAll(
    DeploymentProvider(),
    ManagementLockProvider(),
    ResourceGroupProvider(),
    ResourceLinkProvider(),
    TemplateSpecProvider(),
    TemplateSpecVersionProvider(),
  );
