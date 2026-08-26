# Website example spec

One example per web framework × cloud, named `{aws|cloudflare}-website-{framework}`
(the pre-existing `cloudflare-tanstack` and `cloudflare-solidstart` keep their
names — published blog posts link to them). Every example is the SAME minimal
app — no diversity in content or functionality — so the matrix tests one common
setup per framework: Tailwind CSS, a component in the framework's native flavor,
and the bare-minimum deploy.

## The app (identical everywhere)

A single page:

- `<h1 class="text-3xl font-bold">{greeting}</h1>` — `greeting` is the
  `GREETING` value from the deploy's `env` on server-rendered frameworks
  (fallback `"Hello!"`), or the literal `"Hello from <Framework>!"` on
  client-only frameworks (Vite SPA, Foldkit) which have no server env.
- One `Card` component in the framework's native flavor
  (`Card.tsx` / `Card.astro` / `Card.svelte` / `Card.vue`; Foldkit: a
  `card` view function in plain `.ts` using `foldkit/html`), rendered
  under the heading with EXACTLY these props/content:
  - title: `Styled with Tailwind CSS`
  - body: `This card is a <native-flavor> component styled with Tailwind utilities.`
  - card classes: `mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm`
  - title classes: `text-lg font-semibold`
  - body classes: `mt-2 text-slate-600`
- Page body classes: `bg-slate-50 p-8 text-slate-900`
- Page `<title>`: `<Framework> on <AWS|Cloudflare>`

## Tailwind (v4)

- `src/styles/global.css` (or the framework's conventional location) containing
  exactly `@import "tailwindcss";`, imported from the page/root layout.
- Wired through `@tailwindcss/vite` in the framework's own config file
  (`vite.config.ts`, `astro.config.ts` `vite.plugins`, `nuxt.config.ts`
  `vite.plugins`, `waku.config.ts` `vite`, ...).
- Next.js is the exception: `@tailwindcss/postcss` in `postcss.config.mjs`
  and `@import "tailwindcss";` in `app/globals.css`.

## Deploy (alchemy.run.ts)

- A single `Alchemy.Stack` named `{Aws|Cloudflare}Website{Framework}Example`
  with the cloud's `providers()` + `state()`, deploying the framework's
  composite (`AWS.Website.X` / `Cloudflare.Website.X`;
  React Router / SolidStart / TanStack Start on Cloudflare deploy via
  `Cloudflare.Website.Vite`).
- SSR frameworks pass `env: { GREETING: "Hello from <Framework> on <Cloud>!" }`.
- AWS composites set `forceDestroy: true`.
- Use `memo: { include: [...] }` scoped to the app's source files, following
  the existing examples.
- Return `{ url: site.url }`.

## Files

```
{example}/
  README.md            # short: what it deploys, bun install / bun run deploy
  alchemy.run.ts
  package.json         # deps from catalog:frontend, alchemy: workspace:*, patterned on siblings
  tsconfig.json        # patterned on the sibling example for the same framework/cloud
  <framework config>   # vite.config.ts / astro.config.ts / ... with tailwind plugin
  src/...              # page + Card component + styles/global.css
  test/integ.test.ts   # live deploy + body assertions, patterned on the same
                       # cloud's existing integ tests (alchemy/Test/Bun,
                       # getWhenReady + bounded retry, NO_DESTROY guard)
```

## Rules

- Never run `pnpm install`, `bun install`, or any build — the workspace
  install and verification run once at the coordinator level.
- Copy conventions (package.json fields, tsconfig, integ-test helpers) from
  the existing sibling example of the same cloud; do not invent new patterns.
- Only props that exist on the composites today (check the source in
  `packages/alchemy/src/{AWS,Cloudflare}/Website/`); never invent props.
