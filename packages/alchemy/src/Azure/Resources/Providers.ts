import * as Layer from "effect/Layer";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import {
  DeploymentScript,
  DeploymentScriptProvider,
} from "./DeploymentScript.ts";
import { DeploymentStack, DeploymentStackProvider } from "./DeploymentStack.ts";
import { ManagementLock, ManagementLockProvider } from "./ManagementLock.ts";
import { ResourceGroup, ResourceGroupProvider } from "./ResourceGroup.ts";
import { ResourceLink, ResourceLinkProvider } from "./ResourceLink.ts";
import {
  ResourceManagementPrivateLink,
  ResourceManagementPrivateLinkProvider,
} from "./ResourceManagementPrivateLink.ts";
import { TemplateSpec, TemplateSpecProvider } from "./TemplateSpec.ts";
import {
  TemplateSpecVersion,
  TemplateSpecVersionProvider,
} from "./TemplateSpecVersion.ts";

export const resources = [
  Deployment,
  DeploymentScript,
  DeploymentStack,
  ManagementLock,
  ResourceGroup,
  ResourceLink,
  ResourceManagementPrivateLink,
  TemplateSpec,
  TemplateSpecVersion,
];
export const layers = () =>
  Layer.mergeAll(
    DeploymentProvider(),
    DeploymentScriptProvider(),
    DeploymentStackProvider(),
    ManagementLockProvider(),
    ResourceGroupProvider(),
    ResourceLinkProvider(),
    ResourceManagementPrivateLinkProvider(),
    TemplateSpecProvider(),
    TemplateSpecVersionProvider(),
  );
