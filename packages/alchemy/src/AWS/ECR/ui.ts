import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Image } from "./Image.ts";
import type { RegistryPolicy } from "./RegistryPolicy.ts";
import type { Repository } from "./Repository.ts";

/**
 * Dashboard UI providers for AWS ECR resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const RepositoryUI = UIProvider.succeed<Repository>(
  "AWS.ECR.Repository",
  {
    displayName: "ECR Repository",
    icon: "package",
    color: "#ED7100",
    category: "storage",
    summary: (ctx) => ctx.attrs?.repositoryName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.repositoryArn);
      return region === undefined ||
        ctx.attrs?.registryId === undefined ||
        ctx.attrs?.repositoryName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ecr/repositories/private/${ctx.attrs.registryId}/${ctx.attrs.repositoryName}?region=${region}`;
    },
    facts: (ctx) => [
      { label: "repository", value: ctx.attrs?.repositoryName, copy: true },
      {
        label: "uri",
        value: ctx.attrs?.repositoryUri,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.repositoryArn,
        mono: true,
        copy: true,
      },
      { label: "registry", value: ctx.attrs?.registryId, mono: true },
      { label: "tag mutability", value: ctx.attrs?.imageTagMutability },
      { label: "scan on push", value: ctx.props?.scanOnPush },
    ],
  },
);

export const ImageUI = UIProvider.succeed<Image>("AWS.ECR.Image", {
  displayName: "ECR Image",
  icon: "layers",
  color: "#ED7100",
  category: "storage",
  summary: (ctx) => ctx.attrs?.imageTag,
  facts: (ctx) => [
    { label: "image", value: ctx.attrs?.imageUri, mono: true, copy: true },
    { label: "digest", value: ctx.attrs?.digest, mono: true, copy: true },
    {
      label: "repository",
      value: ctx.attrs?.repositoryName,
      mono: true,
    },
    { label: "tag", value: ctx.attrs?.imageTag, mono: true },
    { label: "owns repository", value: ctx.attrs?.ownsRepository },
  ],
});

export const RegistryPolicyUI = UIProvider.succeed<RegistryPolicy>(
  "AWS.ECR.RegistryPolicy",
  {
    displayName: "ECR Registry Policy",
    icon: "lock",
    color: "#ED7100",
    category: "security",
    summary: (ctx) => ctx.attrs?.registryId,
    facts: (ctx) => [
      {
        label: "registry",
        value: ctx.attrs?.registryId,
        mono: true,
        copy: true,
      },
      { label: "policy", value: ctx.attrs?.policy, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(RepositoryUI, ImageUI, RegistryPolicyUI);
