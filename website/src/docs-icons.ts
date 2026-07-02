/**
 * Icon resolution for the docs chrome (tab bar + sidebar group headings).
 *
 * Two sources, both 24×24 viewBox and theme-adaptive via `currentColor`:
 * - lucide (stroke outlines) for generic concepts (tutorial, data, guides…)
 * - simple-icons (fill) for official provider brand marks (Cloudflare, AWS…)
 */
import { icons as lucide } from "@iconify-json/lucide";
import { icons as brands } from "@iconify-json/simple-icons";

const l = (name: string): string | undefined => lucide.icons[name]?.body;
const b = (name: string): string | undefined => brands.icons[name]?.body;

/** Tab bar icons, keyed by tab label (see docs-tabs.ts). */
export const TAB_ICONS: Record<string, string | undefined> = {
  Docs: l("book-open"),
  Cloudflare: b("cloudflare"),
  AWS: b("amazonwebservices"),
  Integrations: l("plug"),
  Reference: l("code"),
  Blog: l("newspaper"),
};

/** Sidebar group-heading icons, keyed by (normalized) group label. */
const GROUP_ICONS: Record<string, string | undefined> = {
  Tutorial: l("graduation-cap"),
  Compute: l("zap"),
  Data: l("database"),
  Messaging: l("send"),
  "Messaging & Events": l("send"),
  Networking: l("globe"),
  Guides: l("map"),
  Resources: l("boxes"),
  Concepts: l("book-text"),
  // Reference tab: provider groups get their official brand marks.
  AWS: b("amazonwebservices"),
  Cloudflare: b("cloudflare"),
  GitHub: b("github"),
  Neon: b("neon"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Stripe: b("stripe"),
};

/**
 * Resolve a sidebar group label to an icon body. Qualified labels like
 * "Compute — advanced" resolve via their base name.
 */
export function sidebarGroupIcon(label: string): string | undefined {
  return GROUP_ICONS[label] ?? GROUP_ICONS[label.split("—")[0].trim()];
}
