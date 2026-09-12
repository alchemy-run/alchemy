import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Component } from "./Component.ts";
import type { DistributionConfiguration } from "./DistributionConfiguration.ts";
import type { ImagePipeline } from "./ImagePipeline.ts";
import type { ImageRecipe } from "./ImageRecipe.ts";
import type { InfrastructureConfiguration } from "./InfrastructureConfiguration.ts";

/**
 * Dashboard UI providers for AWS Image Builder resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#ED7100";

export const ComponentUI = UIProvider.succeed<Component>(
  "AWS.ImageBuilder.Component",
  {
    displayName: "Image Builder Component",
    icon: "package",
    color: COLOR,
    category: "compute",
    summary: (ctx) => ctx.attrs?.componentName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.componentName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.componentBuildVersionArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.semanticVersion },
      { label: "platform", value: ctx.attrs?.platform },
      { label: "type", value: ctx.attrs?.type },
    ],
  },
);

export const DistributionConfigurationUI =
  UIProvider.succeed<DistributionConfiguration>(
    "AWS.ImageBuilder.DistributionConfiguration",
    {
      displayName: "Image Builder Distribution Configuration",
      icon: "share-2",
      color: COLOR,
      category: "compute",
      summary: (ctx) => ctx.attrs?.distributionConfigurationName,
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.distributionConfigurationName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.distributionConfigurationArn,
          mono: true,
          copy: true,
        },
        { label: "created", value: ctx.attrs?.dateCreated },
      ],
    },
  );

export const ImagePipelineUI = UIProvider.succeed<ImagePipeline>(
  "AWS.ImageBuilder.ImagePipeline",
  {
    displayName: "Image Builder Pipeline",
    icon: "workflow",
    color: COLOR,
    category: "compute",
    summary: (ctx) => ctx.attrs?.imagePipelineName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.imagePipelineName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.imagePipelineArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "platform", value: ctx.attrs?.platform },
    ],
  },
);

export const ImageRecipeUI = UIProvider.succeed<ImageRecipe>(
  "AWS.ImageBuilder.ImageRecipe",
  {
    displayName: "Image Builder Recipe",
    icon: "book-open",
    color: COLOR,
    category: "compute",
    summary: (ctx) => ctx.attrs?.imageRecipeName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.imageRecipeName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.imageRecipeArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.semanticVersion },
      { label: "platform", value: ctx.attrs?.platform },
      { label: "parent image", value: ctx.attrs?.parentImage, mono: true },
    ],
  },
);

export const InfrastructureConfigurationUI =
  UIProvider.succeed<InfrastructureConfiguration>(
    "AWS.ImageBuilder.InfrastructureConfiguration",
    {
      displayName: "Image Builder Infrastructure Configuration",
      icon: "server",
      color: COLOR,
      category: "compute",
      summary: (ctx) => ctx.attrs?.infrastructureConfigurationName,
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.infrastructureConfigurationName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.infrastructureConfigurationArn,
          mono: true,
          copy: true,
        },
        {
          label: "instance profile",
          value: ctx.attrs?.instanceProfileName,
          mono: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    ComponentUI,
    DistributionConfigurationUI,
    ImagePipelineUI,
    ImageRecipeUI,
    InfrastructureConfigurationUI,
  );
