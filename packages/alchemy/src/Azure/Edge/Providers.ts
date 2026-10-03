import * as Layer from "effect/Layer";
import { ConfigTemplate, ConfigTemplateProvider } from "./ConfigTemplate.ts";
import {
  ConfigTemplateMetadata,
  ConfigTemplateMetadataProvider,
} from "./ConfigTemplateMetadata.ts";
import {
  ConfigTemplateVersion,
  ConfigTemplateVersionProvider,
} from "./ConfigTemplateVersion.ts";
import { Configuration, ConfigurationProvider } from "./Configuration.ts";
import {
  ConfigurationReference,
  ConfigurationReferenceProvider,
} from "./ConfigurationReference.ts";
import { Context, ContextProvider } from "./Context.ts";
import { Diagnostic, DiagnosticProvider } from "./Diagnostic.ts";
import {
  DisconnectedOperation,
  DisconnectedOperationProvider,
} from "./DisconnectedOperation.ts";
import {
  DynamicConfiguration,
  DynamicConfigurationProvider,
} from "./DynamicConfiguration.ts";
import {
  DynamicConfigurationVersion,
  DynamicConfigurationVersionProvider,
} from "./DynamicConfigurationVersion.ts";
import { DynamicSchema, DynamicSchemaProvider } from "./DynamicSchema.ts";
import {
  DynamicSchemaVersion,
  DynamicSchemaVersionProvider,
} from "./DynamicSchemaVersion.ts";
import { Schema, SchemaProvider } from "./Schema.ts";
import { SchemaReference, SchemaReferenceProvider } from "./SchemaReference.ts";
import { SchemaVersion, SchemaVersionProvider } from "./SchemaVersion.ts";
import { Site, SiteProvider } from "./Site.ts";
import { SiteReference, SiteReferenceProvider } from "./SiteReference.ts";
import {
  SolutionTemplate,
  SolutionTemplateProvider,
} from "./SolutionTemplate.ts";
import {
  SolutionTemplateVersion,
  SolutionTemplateVersionProvider,
} from "./SolutionTemplateVersion.ts";
import {
  SubscriptionSite,
  SubscriptionSiteProvider,
} from "./SubscriptionSite.ts";
import { Target, TargetProvider } from "./Target.ts";

export const resources = [
  ConfigTemplate,
  ConfigTemplateMetadata,
  ConfigTemplateVersion,
  Configuration,
  ConfigurationReference,
  Context,
  Diagnostic,
  DisconnectedOperation,
  DynamicConfiguration,
  DynamicConfigurationVersion,
  DynamicSchema,
  DynamicSchemaVersion,
  Schema,
  SchemaReference,
  SchemaVersion,
  Site,
  SiteReference,
  SolutionTemplate,
  SolutionTemplateVersion,
  SubscriptionSite,
  Target,
];
export const layers = () =>
  Layer.mergeAll(
    ConfigTemplateProvider(),
    ConfigTemplateMetadataProvider(),
    ConfigTemplateVersionProvider(),
    ConfigurationProvider(),
    ConfigurationReferenceProvider(),
    ContextProvider(),
    DiagnosticProvider(),
    DisconnectedOperationProvider(),
    DynamicConfigurationProvider(),
    DynamicConfigurationVersionProvider(),
    DynamicSchemaProvider(),
    DynamicSchemaVersionProvider(),
    SchemaProvider(),
    SchemaReferenceProvider(),
    SchemaVersionProvider(),
    SiteProvider(),
    SiteReferenceProvider(),
    SolutionTemplateProvider(),
    SolutionTemplateVersionProvider(),
    SubscriptionSiteProvider(),
    TargetProvider(),
  );
