import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Space } from "./Space.ts";

/**
 * Dashboard UI providers for AWS re:Post Private resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const SpaceUI = UIProvider.succeed<Space>("AWS.RePostSpace.Space", {
  displayName: "re:Post Private Space",
  icon: "book-open",
  color: "#E7157B",
  category: "other",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) =>
    ctx.attrs?.vanityDomain === undefined
      ? undefined
      : `https://${ctx.attrs.vanityDomain}`,
  facts: (ctx) => [
    { label: "space", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.spaceId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.spaceArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "tier", value: ctx.attrs?.tier },
    {
      label: "domain",
      value: ctx.attrs?.vanityDomain,
      mono: true,
      copy: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(SpaceUI);
