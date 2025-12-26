import type {
  DefaultEndpointSettings,
  ProjectSettingsData,
} from "@neondatabase/api-client";
import { Resource } from "../resource.ts";

export type NeonRegion =
  | "aws-us-east-1"
  | "aws-us-east-2"
  | "aws-us-west-2"
  | "aws-eu-central-1"
  | "aws-eu-west-2"
  | "aws-ap-southeast-1"
  | "aws-ap-southeast-2"
  | "aws-sa-east-1"
  | "azure-eastus2"
  | "azure-westus3"
  | "azure-gwc"
  | (string & {});

export type NeonPgVersion = 14 | 15 | 16 | 17 | 18;

export type ProjectProps = {
  name?: string;
  regionId?: NeonRegion;
  pgVersion?: NeonPgVersion;
  defaultBranchName?: string;
  settings?: ProjectSettingsData;
  defaultEndpointSettings?: DefaultEndpointSettings;
  historyRetentionSeconds?: number;
  adopt?: boolean;
  delete?: boolean;
};

export type ProjectAttr<Props extends ProjectProps> = {
  projectId: string;
  name: Props["name"] extends string ? Props["name"] : string;
  createdAt: string;
  updatedAt: string;
  proxyHost: string;
  regionId: Props["regionId"] extends NeonRegion
    ? Props["regionId"]
    : "aws-us-east-1";
  pgVersion: Props["pgVersion"] extends NeonPgVersion
    ? Props["pgVersion"]
    : 16;
  settings: Props["settings"] extends ProjectSettingsData
    ? Props["settings"]
    : undefined;
  defaultEndpointSettings: Props["defaultEndpointSettings"] extends DefaultEndpointSettings
    ? Props["defaultEndpointSettings"]
    : undefined;
  historyRetentionSeconds: number;
  defaultBranchId: string;
  defaultEndpointId: string;
};

export interface Project<
  ID extends string = string,
  Props extends ProjectProps = ProjectProps,
> extends Resource<"Neon.Project", ID, Props, ProjectAttr<Props>, Project> {}

export const Project = Resource<{
  <const ID extends string, const Props extends ProjectProps>(
    id: ID,
    props?: Props,
  ): Project<ID, Props>;
}>("Neon.Project");
