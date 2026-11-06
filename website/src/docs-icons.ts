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
  // Modal's mark: modal.com's own favicon (https://modal.com/assets/favicon.svg,
  // 300x300 viewBox), paths verbatim, scaled uniformly into the 24x24 box.
  // simple-icons still ships Modal's older outlined mark.
  modal:
    '<g transform="scale(0.08)"><path d="M121.683 75.25L149.997 124L91.4816 224.75C90.3128 226.757 88.155 228 85.8174 228H32.9664C31.7976 228 30.6778 227.691 29.697 227.131C28.7161 226.57 27.8906 225.758 27.3021 224.75L0.876625 179.25C-0.292208 177.243 -0.292208 174.765 0.876625 172.75L57.512 75.25C58.0923 74.2425 58.9259 73.43 59.9068 72.8694C60.8876 72.3088 62.0074 72 63.1762 72H116.027C118.365 72 120.523 73.2431 121.692 75.25H121.683ZM299.125 172.75L242.49 75.25C241.91 74.2425 241.076 73.43 240.095 72.8694C239.114 72.3088 237.995 72 236.826 72H183.975C181.637 72 179.479 73.2431 178.311 75.25L149.997 124L208.512 224.75C209.681 226.757 211.839 228 214.177 228H267.027C268.196 228 269.316 227.691 270.297 227.131C271.278 226.57 272.103 225.758 272.692 224.75L299.117 179.25C300.286 177.243 300.286 174.765 299.117 172.75H299.125Z" fill="currentColor"/><path d="M89.6018 124H150.005L121.692 75.25C120.523 73.2431 118.365 72 116.027 72H63.1763C62.0074 72 60.8876 72.3088 59.9068 72.8694L89.6018 124Z" fill="currentColor"/><path d="M89.6018 124L59.9068 72.8694C58.9259 73.43 58.1005 74.2425 57.512 75.25L0.876625 172.75C-0.292208 174.765 -0.292208 177.235 0.876625 179.25L27.3021 224.75C27.8825 225.758 28.7161 226.57 29.697 227.131L89.5936 124H89.6018Z" fill="currentColor"/><path d="M149.997 124H89.5936L29.697 227.131C30.6778 227.691 31.7976 228 32.9664 228H85.8174C88.155 228 90.3128 226.757 91.4816 224.75L149.997 124Z" fill="currentColor"/><path d="M299.125 179.25C299.706 178.243 300 177.121 300 176H240.61L210.915 227.131C211.896 227.691 213.016 228 214.185 228H267.036C269.373 228 271.531 226.757 272.7 224.75L299.125 179.25Z" fill="currentColor"/><path d="M183.975 72C182.806 72 181.686 72.3088 180.705 72.8694L240.602 176H299.992C299.992 174.879 299.698 173.758 299.117 172.75L242.49 75.25C241.321 73.2431 239.163 72 236.826 72H183.967H183.975Z" fill="currentColor"/><path d="M210.907 227.131L240.602 176L180.705 72.8694C179.725 73.43 178.899 74.2425 178.311 75.25L149.997 124L208.512 224.75C209.093 225.758 209.926 226.57 210.907 227.131Z" fill="currentColor"/></g>',
  // Full-color variant of the same mark, with the favicon's official fills
  // and gradients (ids prefixed so they can't collide on a page).
  modalColor:
    '<g transform="scale(0.08)"><path d="M121.683 75.25L149.997 124L91.4816 224.75C90.3128 226.757 88.155 228 85.8174 228H32.9664C31.7976 228 30.6778 227.691 29.697 227.131C28.7161 226.57 27.8906 225.758 27.3021 224.75L0.876625 179.25C-0.292208 177.243 -0.292208 174.765 0.876625 172.75L57.512 75.25C58.0923 74.2425 58.9259 73.43 59.9068 72.8694C60.8876 72.3088 62.0074 72 63.1762 72H116.027C118.365 72 120.523 73.2431 121.692 75.25H121.683ZM299.125 172.75L242.49 75.25C241.91 74.2425 241.076 73.43 240.095 72.8694C239.114 72.3088 237.995 72 236.826 72H183.975C181.637 72 179.479 73.2431 178.311 75.25L149.997 124L208.512 224.75C209.681 226.757 211.839 228 214.177 228H267.027C268.196 228 269.316 227.691 270.297 227.131C271.278 226.57 272.103 225.758 272.692 224.75L299.117 179.25C300.286 177.243 300.286 174.765 299.117 172.75H299.125Z" fill="#62DE61"/><path d="M89.6018 124H150.005L121.692 75.25C120.523 73.2431 118.365 72 116.027 72H63.1763C62.0074 72 60.8876 72.3088 59.9068 72.8694L89.6018 124Z" fill="url(#modal-paint0_linear_380_261)"/><path d="M89.6018 124L59.9068 72.8694C58.9259 73.43 58.1005 74.2425 57.512 75.25L0.876625 172.75C-0.292208 174.765 -0.292208 177.235 0.876625 179.25L27.3021 224.75C27.8825 225.758 28.7161 226.57 29.697 227.131L89.5936 124H89.6018Z" fill="url(#modal-paint1_linear_380_261)"/><path d="M149.997 124H89.5936L29.697 227.131C30.6778 227.691 31.7976 228 32.9664 228H85.8174C88.155 228 90.3128 226.757 91.4816 224.75L149.997 124Z" fill="#09AF58"/><path d="M299.125 179.25C299.706 178.243 300 177.121 300 176H240.61L210.915 227.131C211.896 227.691 213.016 228 214.185 228H267.036C269.373 228 271.531 226.757 272.7 224.75L299.125 179.25Z" fill="#09AF58"/><path d="M183.975 72C182.806 72 181.686 72.3088 180.705 72.8694L240.602 176H299.992C299.992 174.879 299.698 173.758 299.117 172.75L242.49 75.25C241.321 73.2431 239.163 72 236.826 72H183.967H183.975Z" fill="url(#modal-paint2_linear_380_261)"/><path d="M210.907 227.131L240.602 176L180.705 72.8694C179.725 73.43 178.899 74.2425 178.311 75.25L149.997 124L208.512 224.75C209.093 225.758 209.926 226.57 210.907 227.131Z" fill="url(#modal-paint3_linear_380_261)"/><defs><linearGradient id="modal-paint0_linear_380_261" x1="127.348" y1="137" x2="82.9561" y2="59.6398" gradientUnits="userSpaceOnUse"><stop stop-color="#BFF9B4"/><stop offset="1" stop-color="#80EE64"/></linearGradient><linearGradient id="modal-paint1_linear_380_261" x1="7.04774" y1="214.131" x2="81.1284" y2="85.0556" gradientUnits="userSpaceOnUse"><stop stop-color="#80EE64"/><stop offset="0.18" stop-color="#7BEB63"/><stop offset="0.36" stop-color="#6FE562"/><stop offset="0.55" stop-color="#5ADA60"/><stop offset="0.74" stop-color="#3DCA5D"/><stop offset="0.93" stop-color="#18B759"/><stop offset="1" stop-color="#09AF58"/></linearGradient><linearGradient id="modal-paint2_linear_380_261" x1="278.103" y1="188.561" x2="204.022" y2="59.4863" gradientUnits="userSpaceOnUse"><stop stop-color="#BFF9B4"/><stop offset="1" stop-color="#80EE64"/></linearGradient><linearGradient id="modal-paint3_linear_380_261" x1="232.804" y1="214.569" x2="158.724" y2="85.4864" gradientUnits="userSpaceOnUse"><stop stop-color="#80EE64"/><stop offset="0.18" stop-color="#7BEB63"/><stop offset="0.36" stop-color="#6FE562"/><stop offset="0.55" stop-color="#5ADA60"/><stop offset="0.74" stop-color="#3DCA5D"/><stop offset="0.93" stop-color="#18B759"/><stop offset="1" stop-color="#09AF58"/></linearGradient></defs></g>',
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
  Modal: c("modal"),
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
  Sandboxes: l("box"),
  Storage: l("hard-drive"),
  Functions: l("square-function"),
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
  Modal: c("modal"),
  Planetscale: b("planetscale"),
  PlanetScale: b("planetscale"),
  Prisma: c("prisma"),
  Axiom: c("axiom"),
  Docker: b("docker"),
  Kubernetes: b("kubernetes"),
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
