/**
 * Icon resolution for the docs chrome (tab bar + sidebar group headings).
 *
 * Three sources, all 24×24 viewBox and theme-adaptive via `currentColor`:
 * - lucide (stroke outlines) for generic concepts (tutorial, data, guides…)
 * - simple-icons (fill) for official provider brand marks (Cloudflare, AWS…)
 * - custom (fill) for brand marks simple-icons has not caught up with yet
 */
import { icons as lucide } from "@iconify-json/lucide";
import { icons as brands } from "@iconify-json/simple-icons";

/**
 * Brand marks in the same body format simple-icons emits, for vendors whose
 * upstream icon is stale. Delete an entry once simple-icons ships the new
 * mark and move the call site back to `b()`.
 */
const custom: Record<string, string> = {
  // Official mark: https://axiom.co/axiom-brand-assets.zip
  // Preserve its 800×690 proportions, centered in our 24×24 icon box.
  axiom:
    '<g transform="translate(0 1.65) scale(0.03)"><path fill="currentColor" d="M792.736 481.458L622.15 196.164C614.327 183.052 595.051 172.324 579.311 172.324H472.812C448.058 172.324 437.911 155.47 450.257 134.872L508.662 37.4525C513.296 29.7211 513.285 20.2029 508.637 12.4796C503.986 4.75638 495.399 0 486.106 0H337.536C321.798 0 302.48 10.7039 294.606 23.7869L5.91039 503.427C-1.9666 516.51 -1.96962 537.921 5.8983 551.006L80.182 674.547C92.5601 695.13 112.858 695.154 125.287 674.599L183.33 578.624C195.763 558.069 216.057 558.093 228.435 578.675L281.058 666.192C288.925 679.277 308.24 689.983 323.979 689.983H667.291C683.024 689.983 702.342 679.277 710.21 666.192L792.65 529.092C800.518 516.006 800.556 494.571 792.736 481.458ZM562.356 467.727C574.656 488.351 564.468 505.228 539.714 505.228H272.672C247.919 505.228 237.791 488.385 250.17 467.803L383.793 245.58C396.17 224.997 416.422 224.997 428.799 245.581L562.356 467.727Z"/></g>',
  // Prisma's 2026 prism mark; simple-icons still ships the pre-2026 logo.
  // Traced from the "Symbol" artwork in Prisma's brand kit (263×264), scaled
  // uniformly and centred — the mark must not be stretched to fill the box.
  // The official Git mark (git-scm.com/downloads/logos, "Git-Icon-Black.svg";
  // logo by Jason Long, CC BY 3.0), used verbatim: its 78×78 viewBox is
  // scaled into the 24×24 box and the fill swapped for currentColor.
  git: '<g transform="scale(0.307692)"><path fill="currentColor" transform="translate(10 10) rotate(-45 29 29)" d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"/></g>',
  prisma:
    '<path fill="currentColor" d="M5.2578 8.4091L0.0455 13.6308V4.8636L4.8828 0.0095V0H13.6385L5.2578 8.4091Z M23.9545 8.3405L8.3231 24H0.0455V15.6572L15.6745 0H23.9545V8.3405Z M19.1078 24H10.3521L14.2685 20.0703L23.9546 10.3667V19.1364L19.1078 24Z"/>',
  // Full-color variant of the same prism mark, band fills taken from the
  // official prisma.io/icon.svg. The docs chrome keeps the currentColor
  // silhouette above; brand-colored surfaces (landing marquee) use this one.
  prismaColor:
    '<path fill="#04D5E7" d="M5.2578 8.4091L0.0455 13.6308V4.8636L4.8828 0.0095V0H13.6385L5.2578 8.4091Z"/><path fill="#FE4352" d="M23.9545 8.3405L8.3231 24H0.0455V15.6572L15.6745 0H23.9545V8.3405Z"/><path fill="#FEBE29" d="M19.1078 24H10.3521L14.2685 20.0703L23.9546 10.3667V19.1364L19.1078 24Z"/>',
  // The official Effect mark (effect.website/favicon.svg), used verbatim
  // without its background tile: the mark spans 20–160 of the 180×180
  // viewBox, so it is shifted and scaled into the 24×24 box, white swapped
  // for currentColor.
  effect:
    '<g transform="scale(0.171429) translate(-20 -20)"><path fill-rule="evenodd" clip-rule="evenodd" d="M159.997 61.2667C160.058 63.2159 159.249 64.9497 157.408 65.9741L139.241 76.0758L155.742 85.3565C157.604 86.4034 158.595 88.3813 158.44 90.3561C158.584 92.3912 157.804 94.2215 155.922 95.2819L93.4411 130.239C92.1387 130.972 90.6802 131.293 89.3417 130.925C88.7428 130.761 88.2007 130.56 87.6313 130.239L25.258 95.1599C23.396 94.113 22.4059 92.1321 22.5612 90.1573C22.4172 88.1222 23.1962 86.295 25.0785 85.2345L41.7611 75.8528L23.7754 65.8506C23.2399 65.5523 22.7769 65.1817 22.3885 64.7569C22.2204 64.5958 22.0658 64.4225 21.9278 64.2372C21.7845 64.0459 21.6585 63.8441 21.553 63.6302C21.5017 63.4961 21.4542 63.362 21.4097 63.228L21.3139 62.9839L21.2468 62.7881C21.2151 62.6902 21.1872 62.5908 21.1616 62.4899L21.1193 62.3091C21.0288 61.8933 20.9896 61.4655 21.0032 61.0362C20.9421 59.087 21.7513 57.3531 23.5921 56.3288L87.3847 20.8554C87.9202 20.5571 88.7678 20.2555 89.3417 20.1455C90.1953 19.9813 90.8439 19.9238 91.6583 20.1455C92.2787 20.3144 92.8514 20.655 93.4343 20.9789L157.225 56.4523C157.32 56.5051 157.413 56.5608 157.504 56.6195C157.59 56.6738 157.673 56.7295 157.755 56.7867C157.83 56.841 157.904 56.8967 157.976 56.954C158.207 57.1362 158.419 57.3351 158.613 57.5475C158.763 57.6921 158.901 57.8442 159.027 58.0054C159.189 58.2133 159.33 58.4362 159.447 58.6727C159.498 58.8068 159.545 58.9394 159.59 59.0734C159.88 59.7648 160.021 60.5135 159.997 61.2667ZM37.8397 90.1603L90.5 120.386L143.16 90.3561L128.595 81.9958L93.3958 101.384C92.0633 102.125 91.0792 102.542 89.6313 102.252C89.0038 102.15 88.1871 101.707 87.6042 101.384L52.4787 81.812L37.8397 90.1603Z" fill="currentColor"/><path d="M25.5536 118.558C26.9879 116.145 30.1597 115.33 32.6385 116.708L90.5 149.546L148.532 116.826C151.011 115.446 154.503 116.421 155.617 118.676C156.67 121.434 156.177 124.188 153.691 125.57L93.3958 159.019C92.138 159.719 90.9246 160.238 89.6313 159.887C89.5642 159.869 89.1222 159.738 88.7625 159.598C88.58 159.527 88.0061 159.241 87.6042 159.019L27.4819 125.454C24.9933 124.07 24.1162 120.984 25.5536 118.558Z" fill="currentColor"/></g>',
  // The official Rivet mark (github.com/rivet-dev/rivet,
  // .github/media/platforms/rivet-white.svg), used verbatim: its 68×68
  // viewBox is scaled into the 24×24 box and white swapped for currentColor.
  rivet:
    '<g transform="scale(0.352941)"><rect x="3" y="3" width="62" height="62" rx="17.55" fill="none" stroke="currentColor" stroke-width="6"/><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M28.9979 19.7671C28.9979 19.3436 28.6541 19 28.2308 19H22.4809C20.5597 19 19 20.5597 19 22.4807V45.5125C19 47.4335 20.5597 48.9935 22.4809 48.9935H28.2308C28.6541 48.9935 28.9979 48.6496 28.9979 48.2263V19.7671ZM45.6293 38.7439C44.7861 37.231 42.8732 36.0028 41.3604 36.0028H32.5577C32.0922 36.0028 31.9249 36.3807 32.1843 36.8462L37.4298 46.2586C38.273 47.7717 40.1858 49 41.6987 49H50.5012C50.9667 49 51.1342 48.6221 50.8745 48.1563L45.6293 38.7439ZM45.9963 25.9983C45.9963 22.1359 42.8604 19 38.9977 19H32.8227C32.3682 19 31.9994 19.3688 31.9994 19.8233V32.1734C31.9994 32.6278 32.3682 32.9969 32.8227 32.9969H38.9977C42.8604 32.9969 45.9963 29.861 45.9963 25.9983Z"/></g>',
  // Stripe's 2025 rebrand mark (svgl.app/library/stripe.svg, viewBox
  // "100 100 312 312"), scaled into the 24×24 box. simple-icons still
  // ships the pre-rebrand "S" glyph.
  stripe:
    '<g transform="scale(0.076923) translate(-100 -100)"><path fill="currentColor" fill-rule="evenodd" d="m120 392 272-57.683V120l-272 58.357z" clip-rule="evenodd"/></g>',
};

const l = (name: string): string | undefined => lucide.icons[name]?.body;
const b = (name: string): string | undefined => brands.icons[name]?.body;
const c = (name: string): string | undefined => custom[name];

/** Tab bar icons, keyed by tab label (see docs-tabs.ts). */
export const TAB_ICONS: Record<string, string | undefined> = {
  Core: l("book-open"),
  CLI: l("square-terminal"),
  Cloudflare: b("cloudflare"),
  AWS: b("amazonwebservices"),
  GCP: b("googlecloud"),
  Hetzner: b("hetzner"),
  Fly: b("flydotio"),
  Railway: b("railway"),
  PlanetScale: b("planetscale"),
  Neon: b("neon"),
  Turso: b("turso"),
  Prisma: c("prisma"),
  // Brand-colored prism for marketing surfaces (see `prismaColor` above).
  PrismaColor: c("prismaColor"),
  Axiom: c("axiom"),
  "Better Auth": l("key-round"),
  GitHub: b("github"),
  Git: c("git"),
  Stripe: c("stripe"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Rivet: c("rivet"),
  "Effect Cluster": c("effect"),
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
  Databases: l("database"),
  Access: l("key-round"),
  Messaging: l("send"),
  "Messaging & Events": l("send"),
  "Messaging & events": l("send"),
  Email: l("mail"),
  AI: l("sparkles"),
  "Security & secrets": l("lock"),
  "Accounts & access": l("key-round"),
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
  Clusters: l("network"),
  Workloads: l("container"),
  Objects: l("file-code"),
  Frontends: l("monitor-smartphone"),
  Security: l("shield-check"),
  "Consistency patterns": l("git-merge"),
  Hosting: l("server"),
  Platforms: l("cloud"),
  "Building Actors": l("boxes"),
  "Running Rivet": l("server-cog"),
  Testing: l("flask-conical"),
  Domain: l("blocks"),
  // Reference tab: provider groups get their official brand marks.
  AWS: b("amazonwebservices"),
  Cloudflare: b("cloudflare"),
  GCP: b("googlecloud"),
  Hetzner: b("hetzner"),
  Fly: b("flydotio"),
  Railway: b("railway"),
  GitHub: b("github"),
  Neon: b("neon"),
  Turso: b("turso"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Prisma: c("prisma"),
  Axiom: c("axiom"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
  Rivet: c("rivet"),
  Cluster: c("effect"),
  Drizzle: b("drizzle"),
  "Prisma ORM": b("prisma"),
  SQL: l("database"),
  "Effect SQL": l("database-zap"),
  Migrations: l("list-ordered"),
  Command: l("square-terminal"),
  Stripe: c("stripe"),
  ACME: l("shield-check"),
};

/**
 * Resolve a sidebar group label to an icon body. Qualified labels like
 * "Compute — advanced" resolve via their base name.
 */
export function sidebarGroupIcon(label: string): string | undefined {
  return GROUP_ICONS[label] ?? GROUP_ICONS[label.split("—")[0].trim()];
}
