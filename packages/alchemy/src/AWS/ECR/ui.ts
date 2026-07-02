import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
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

export const ui = () => Layer.mergeAll(RepositoryUI);
