import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { PublicRepository } from "./Repository.ts";

/**
 * Dashboard UI providers for AWS ECRPublic resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const PublicRepositoryUI = UIProvider.succeed<PublicRepository>(
  "AWS.ECRPublic.Repository",
  {
    displayName: "ECR Public Repository",
    icon: "package",
    color: "#ED7100",
    category: "storage",
    summary: (ctx) => ctx.attrs?.repositoryName,
    link: (ctx) =>
      ctx.attrs?.repositoryUri === undefined
        ? undefined
        : `https://${ctx.attrs.repositoryUri}`,
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
      { label: "policy", value: ctx.attrs?.policyText, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(PublicRepositoryUI);
