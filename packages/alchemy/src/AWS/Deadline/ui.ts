import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Budget } from "./Budget.ts";
import type { Farm } from "./Farm.ts";
import type { Fleet } from "./Fleet.ts";
import type { Monitor } from "./Monitor.ts";
import type { Queue } from "./Queue.ts";
import type { StorageProfile } from "./StorageProfile.ts";

/**
 * Dashboard UI providers for AWS Deadline resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const DEADLINE_COLOR = "#ED7100";

export const BudgetUI = UIProvider.succeed<Budget>("AWS.Deadline.Budget", {
  displayName: "Deadline Budget",
  icon: "dollar-sign",
  color: DEADLINE_COLOR,
  category: "billing",
  summary: (ctx) => ctx.attrs?.displayName,
  facts: (ctx) => [
    { label: "budget", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.budgetId, mono: true },
    { label: "arn", value: ctx.attrs?.budgetArn, mono: true, copy: true },
    { label: "farm", value: ctx.attrs?.farmId, mono: true },
    { label: "queue", value: ctx.attrs?.queueId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "limit", value: ctx.attrs?.approximateDollarLimit },
  ],
});

export const FarmUI = UIProvider.succeed<Farm>("AWS.Deadline.Farm", {
  displayName: "Deadline Farm",
  icon: "server",
  color: DEADLINE_COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.displayName,
  facts: (ctx) => [
    { label: "farm", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.farmId, mono: true },
    { label: "arn", value: ctx.attrs?.farmArn, mono: true, copy: true },
    { label: "cost scale factor", value: ctx.attrs?.costScaleFactor },
    { label: "kms key", value: ctx.attrs?.kmsKeyArn, mono: true },
  ],
});

export const FleetUI = UIProvider.succeed<Fleet>("AWS.Deadline.Fleet", {
  displayName: "Deadline Fleet",
  icon: "boxes",
  color: DEADLINE_COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.displayName,
  facts: (ctx) => [
    { label: "fleet", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.fleetId, mono: true },
    { label: "arn", value: ctx.attrs?.fleetArn, mono: true, copy: true },
    { label: "farm", value: ctx.attrs?.farmId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "workers", value: ctx.attrs?.workerCount },
    { label: "max workers", value: ctx.attrs?.maxWorkerCount },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
  ],
});

export const MonitorUI = UIProvider.succeed<Monitor>("AWS.Deadline.Monitor", {
  displayName: "Deadline Monitor",
  icon: "eye",
  color: DEADLINE_COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.displayName,
  link: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "monitor", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.monitorId, mono: true },
    { label: "arn", value: ctx.attrs?.monitorArn, mono: true, copy: true },
    { label: "subdomain", value: ctx.attrs?.subdomain },
    { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url, copy: true },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
  ],
});

export const QueueUI = UIProvider.succeed<Queue>("AWS.Deadline.Queue", {
  displayName: "Deadline Queue",
  icon: "list-ordered",
  color: DEADLINE_COLOR,
  category: "queue",
  summary: (ctx) => ctx.attrs?.displayName,
  facts: (ctx) => [
    { label: "queue", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.queueId, mono: true },
    { label: "arn", value: ctx.attrs?.queueArn, mono: true, copy: true },
    { label: "farm", value: ctx.attrs?.farmId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "budget action", value: ctx.attrs?.defaultBudgetAction },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
  ],
});

export const StorageProfileUI = UIProvider.succeed<StorageProfile>(
  "AWS.Deadline.StorageProfile",
  {
    displayName: "Deadline Storage Profile",
    icon: "hard-drive",
    color: DEADLINE_COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.displayName,
    facts: (ctx) => [
      { label: "profile", value: ctx.attrs?.displayName, copy: true },
      { label: "id", value: ctx.attrs?.storageProfileId, mono: true },
      { label: "farm", value: ctx.attrs?.farmId, mono: true },
      { label: "os", value: ctx.attrs?.osFamily },
      {
        label: "locations",
        value: ctx.attrs?.fileSystemLocations?.length,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    BudgetUI,
    FarmUI,
    FleetUI,
    MonitorUI,
    QueueUI,
    StorageProfileUI,
  );
