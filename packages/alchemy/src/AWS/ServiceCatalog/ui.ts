import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Portfolio } from "./Portfolio.ts";
import type { PortfolioProductAssociation } from "./PortfolioProductAssociation.ts";
import type { PrincipalPortfolioAssociation } from "./PrincipalPortfolioAssociation.ts";
import type { Product } from "./Product.ts";

/**
 * Dashboard UI providers for AWS ServiceCatalog resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const PortfolioUI = UIProvider.succeed<Portfolio>(
  "AWS.ServiceCatalog.Portfolio",
  {
    displayName: "Service Catalog Portfolio",
    icon: "briefcase",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.portfolioName,
    facts: (ctx) => [
      { label: "portfolio", value: ctx.attrs?.portfolioName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.portfolioId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.portfolioArn, mono: true, copy: true },
      { label: "owner", value: ctx.props?.providerName },
    ],
  },
);

export const PortfolioProductAssociationUI =
  UIProvider.succeed<PortfolioProductAssociation>(
    "AWS.ServiceCatalog.PortfolioProductAssociation",
    {
      displayName: "Portfolio Product Association",
      icon: "link",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.productId,
      facts: (ctx) => [
        {
          label: "portfolio",
          value: ctx.attrs?.portfolioId,
          mono: true,
          copy: true,
        },
        {
          label: "product",
          value: ctx.attrs?.productId,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const PrincipalPortfolioAssociationUI =
  UIProvider.succeed<PrincipalPortfolioAssociation>(
    "AWS.ServiceCatalog.PrincipalPortfolioAssociation",
    {
      displayName: "Principal Portfolio Association",
      icon: "users",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.principalArn,
      facts: (ctx) => [
        {
          label: "portfolio",
          value: ctx.attrs?.portfolioId,
          mono: true,
          copy: true,
        },
        {
          label: "principal",
          value: ctx.attrs?.principalArn,
          mono: true,
          copy: true,
        },
        { label: "type", value: ctx.attrs?.principalType },
      ],
    },
  );

export const ProductUI = UIProvider.succeed<Product>(
  "AWS.ServiceCatalog.Product",
  {
    displayName: "Service Catalog Product",
    icon: "package",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.productName,
    facts: (ctx) => [
      { label: "product", value: ctx.attrs?.productName, copy: true },
      { label: "id", value: ctx.attrs?.productId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.productArn, mono: true, copy: true },
      {
        label: "provisioning artifact",
        value: ctx.attrs?.provisioningArtifactId,
        mono: true,
      },
      { label: "owner", value: ctx.props?.owner },
      { label: "type", value: ctx.props?.productType },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    PortfolioUI,
    PortfolioProductAssociationUI,
    PrincipalPortfolioAssociationUI,
    ProductUI,
  );
