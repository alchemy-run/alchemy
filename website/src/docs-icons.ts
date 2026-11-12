/**
 * Icon resolution for the docs chrome (tab bar + sidebar group headings).
 *
 * Two sources, both 24×24 viewBox and theme-adaptive via `currentColor`:
 * - lucide (stroke outlines) for generic concepts (tutorial, data, guides…)
 * - vendored official brand marks (fill) for providers (Cloudflare, AWS…)
 */
import { icons as lucide } from "@iconify-json/lucide";

/**
 * Brand marks, vendored from each vendor's own brand assets into
 * `src/icons/brands/<name>.svg` (each file names its source). Every file is
 * a 24×24 single-color mark drawn in currentColor, except the `-color`
 * variants used on marketing surfaces.
 */
const brandFiles = import.meta.glob<string>("./icons/brands/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});
const brandMarks: Record<string, string> = Object.fromEntries(
  Object.entries(brandFiles).map(([file, svg]) => [
    file.replace(/^.*\/(.*)\.svg$/, "$1"),
    svg
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .trim(),
  ]),
);

const l = (name: string): string | undefined => lucide.icons[name]?.body;
const b = (name: string): string | undefined => brandMarks[name];

/**
 * An icon for a diagram node: a lucide name (`database`, `server`), or a
 * vendored brand mark as `brand:<name>` (`brand:docker`, `brand:postgresql`).
 */
export function diagramIcon(name: string): string | undefined {
  return name.startsWith("brand:") ? b(name.slice("brand:".length)) : l(name);
}

/** Tab bar icons, keyed by tab label (see docs-tabs.ts). */
export const TAB_ICONS: Record<string, string | undefined> = {
  Core: l("book-open"),
  CLI: l("square-terminal"),
  Cloudflare: b("cloudflare"),
  AWS: b("aws"),
  GCP: b("gcp"),
  Hetzner: b("hetzner"),
  Fly: b("fly"),
  Railway: b("railway"),
  PlanetScale: b("planetscale"),
  Neon: b("neon"),
  Turso: b("turso"),
  E2B: b("e2b"),
  Daytona: b("daytona"),
  Modal: b("modal"),
  Archil: b("archil"),
  Boat: b("boat"),
  // The Sandboxes dropdown's link to the AWS hub's Nitro Sandboxes page.
  "AWS Nitro": b("aws"),
  Prisma: b("prisma"),
  // Brand-colored prism for marketing surfaces.
  PrismaColor: b("prisma-color"),
  Axiom: b("axiom"),
  "Better Auth": b("betterauth"),
  GitHub: b("github"),
  Git: b("git"),
  Stripe: b("stripe"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Rivet: b("rivet"),
  "Effect Cluster": b("effect"),
  Drizzle: b("drizzle"),
  SQL: l("database"),
  Command: l("square-terminal"),
  ACME: l("shield-check"),
  Domain: l("blocks"),
  Reference: l("code"),
  Blog: l("newspaper"),
  Compare: l("scale"),
};

/** Sidebar group-heading icons, keyed by (normalized) group label. */
const GROUP_ICONS: Record<string, string | undefined> = {
  Tutorial: l("graduation-cap"),
  Deploy: l("rocket"),
  Develop: l("refresh-cw"),
  Auth: l("key-round"),
  State: l("hard-drive"),
  Providers: l("plug"),
  "Infrastructure as Code": l("code"),
  "Infrastructure as Effects": l("layers"),
  "State Store": l("hard-drive"),
  "Project structure": l("folder-tree"),
  Environments: l("sliders-horizontal"),
  "Testing & observability": l("flask-conical"),
  Compute: l("zap"),
  Frontend: l("layout-template"),
  APIs: l("braces"),
  Data: l("database"),
  Storage: l("hard-drive"),
  Databases: l("database"),
  Access: l("key-round"),
  Messaging: l("send"),
  "Messaging & Events": l("send"),
  "Messaging & events": l("send"),
  Email: l("mail"),
  AI: l("sparkles"),
  "Security & secrets": l("lock"),
  "Accounts & access": l("key-round"),
  "Engines & access": l("key-round"),
  Images: l("package"),
  Swarm: l("network"),
  "Access & security": l("key-round"),
  "Storage & databases": l("database"),
  "Networking & edge": l("globe"),
  Workers: l("zap"),
  Engines: l("cpu"),
  Postgres: l("database"),
  Applications: l("app-window"),
  Organization: l("building"),
  "Durable Objects": l("box"),
  Workflows: l("workflow"),
  Containers: l("container"),
  Observability: l("activity"),
  Networking: l("globe"),
  Guides: l("map"),
  Resources: l("boxes"),
  Concepts: l("book-text"),
  Sandboxes: l("box"),
  Events: l("bell"),
  Clusters: l("network"),
  Workloads: l("container"),
  Objects: l("file-code"),
  Frontends: l("monitor-smartphone"),
  Security: l("shield-check"),
  Sandboxes: l("box"),
  "Consistency patterns": l("git-merge"),
  Hosting: l("server"),
  Clients: l("plug"),
  Patterns: l("puzzle"),
  Operations: l("gauge"),
  Platforms: l("cloud"),
  "Building Actors": l("boxes"),
  "Running Rivet": l("server-cog"),
  Building: l("boxes"),
  Running: l("server-cog"),
  "Rivet Services": l("waves"),
  Testing: l("flask-conical"),
  Domain: l("blocks"),
  // Reference tab: provider groups get their official brand marks.
  AWS: b("aws"),
  Cloudflare: b("cloudflare"),
  GCP: b("gcp"),
  Hetzner: b("hetzner"),
  Fly: b("fly"),
  Railway: b("railway"),
  GitHub: b("github"),
  Neon: b("neon"),
  Turso: b("turso"),
  E2B: b("e2b"),
  Daytona: b("daytona"),
  Modal: b("modal"),
  Archil: b("archil"),
  Boat: b("boat"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Prisma: b("prisma"),
  Axiom: b("axiom"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Rivet: b("rivet"),
  Cluster: b("effect"),
  Drizzle: b("drizzle"),
  BetterAuth: b("betterauth"),
  Doppler: b("doppler"),
  Infisical: b("infisical"),
  Git: b("git"),
  "Prisma ORM": b("prisma"),
  SQL: l("database"),
  "Effect SQL": l("database-zap"),
  Migrations: l("list-ordered"),
  Command: l("square-terminal"),
  Stripe: b("stripe"),
  ACME: l("shield-check"),
};

/**
 * Resolve a sidebar group label to an icon body. Qualified labels like
 * "Compute — advanced" resolve via their base name.
 */
export function sidebarGroupIcon(label: string): string | undefined {
  return GROUP_ICONS[label] ?? GROUP_ICONS[label.split("—")[0].trim()];
}
