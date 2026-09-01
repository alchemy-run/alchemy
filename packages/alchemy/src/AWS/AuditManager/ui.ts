import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Assessment } from "./Assessment.ts";
import type { Control } from "./Control.ts";
import type { Framework } from "./Framework.ts";

/**
 * Dashboard UI providers for AWS AuditManager resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (Audit Manager) brand red. */
const COLOR = "#DD344C";

export const AssessmentUI = UIProvider.succeed<Assessment>(
  "AWS.AuditManager.Assessment",
  {
    displayName: "Audit Manager Assessment",
    icon: "scroll-text",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "assessment id",
        value: ctx.attrs?.assessmentId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "framework", value: ctx.attrs?.frameworkId, mono: true },
    ],
  },
);

export const ControlUI = UIProvider.succeed<Control>(
  "AWS.AuditManager.Control",
  {
    displayName: "Audit Manager Control",
    icon: "shield-check",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "control id",
        value: ctx.attrs?.controlId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const FrameworkUI = UIProvider.succeed<Framework>(
  "AWS.AuditManager.Framework",
  {
    displayName: "Audit Manager Framework",
    icon: "book-open",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "framework id",
        value: ctx.attrs?.frameworkId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
    ],
  },
);

export const ui = () => Layer.mergeAll(AssessmentUI, ControlUI, FrameworkUI);
