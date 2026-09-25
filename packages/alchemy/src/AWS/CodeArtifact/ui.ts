import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Domain } from "./Domain.ts";
import type { Repository } from "./Repository.ts";

/**
 * Dashboard UI providers for AWS CodeArtifact resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const DomainUI = UIProvider.succeed<Domain>("AWS.CodeArtifact.Domain", {
  displayName: "CodeArtifact Domain",
  icon: "package",
  color: "#7AA116",
  category: "storage",
  summary: (ctx) => ctx.attrs?.domainName,
  facts: (ctx) => [
    { label: "domain", value: ctx.attrs?.domainName, copy: true },
    { label: "arn", value: ctx.attrs?.domainArn, mono: true, copy: true },
    { label: "owner", value: ctx.attrs?.owner, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "encryption key", value: ctx.attrs?.encryptionKey, mono: true },
  ],
});

export const RepositoryUI = UIProvider.succeed<Repository>(
  "AWS.CodeArtifact.Repository",
  {
    displayName: "CodeArtifact Repository",
    icon: "boxes",
    color: "#7AA116",
    category: "storage",
    summary: (ctx) => ctx.attrs?.repositoryName,
    facts: (ctx) => [
      { label: "repository", value: ctx.attrs?.repositoryName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.repositoryArn,
        mono: true,
        copy: true,
      },
      { label: "domain", value: ctx.attrs?.domainName, copy: true },
      { label: "domain owner", value: ctx.attrs?.domainOwner, mono: true },
      {
        label: "external connection",
        value: ctx.props?.externalConnection,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(DomainUI, RepositoryUI);
