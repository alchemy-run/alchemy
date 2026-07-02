import type { UICategory } from "alchemy/UI/UIProvider";

/** Brand fallback colors per cloud prefix (first segment of the type). */
export const CLOUD_COLORS: Record<string, string> = {
  AWS: "#FF9900",
  Cloudflare: "#F6821F",
  GitHub: "#9198a1",
  Neon: "#00E599",
  PlanetScale: "#f97316",
  Planetscale: "#f97316",
  Axiom: "#3b82f6",
  Docker: "#2496ED",
};

/** Default lucide icon per category. */
export const CATEGORY_ICONS: Record<UICategory, string> = {
  compute: "cpu",
  storage: "hard-drive",
  database: "database",
  network: "network",
  dns: "globe",
  queue: "list-ordered",
  eventing: "zap",
  ai: "sparkles",
  auth: "key-round",
  security: "shield",
  observability: "activity",
  cdn: "cloud",
  email: "mail",
  media: "image",
  config: "settings-2",
  billing: "credit-card",
  other: "box",
};

export const PLAN_COLORS: Record<string, string> = {
  create: "#34d399",
  update: "#fbbf24",
  replace: "#c084fc",
  delete: "#f87171",
};

export const PLAN_LABELS: Record<string, string> = {
  create: "+ create",
  update: "~ update",
  replace: "↻ replace",
  delete: "− delete",
};

const IN_FLIGHT = new Set([
  "creating",
  "updating",
  "replacing",
  "deleting",
  "running",
  "pre-creating",
  "creating replacement",
  "attaching",
  "post-attach",
]);

export const statusColor = (status: string): string => {
  switch (status) {
    case "created":
    case "updated":
    case "ran":
      return "#34d399";
    case "fail":
      return "#f87171";
    case "replaced":
    case "deleted":
    case "skipped":
      return "#71717a";
    case "deleting":
      return "#f87171";
    default:
      return IN_FLIGHT.has(status) ? "#fbbf24" : "#71717a";
  }
};

export const statusInFlight = (status: string): boolean =>
  IN_FLIGHT.has(status);

/** Last segment of a resource type: "AWS.S3.Bucket" -> "Bucket". */
export const typeName = (type: string): string =>
  type.split(".").at(-1) ?? type;

/** First segment: "AWS.S3.Bucket" -> "AWS". */
export const cloudOf = (type: string): string => type.split(".")[0] ?? type;

/** Middle segments: "AWS.S3.Bucket" -> "S3". */
export const serviceOf = (type: string): string =>
  type.split(".").slice(1, -1).join(".");
