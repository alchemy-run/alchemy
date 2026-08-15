# `@alchemy.run/frontend-frameworks/vite`

The generic Vite integration: builds any vite-plugin framework (TanStack
Start, SolidStart, ...) — or a plain Vite SPA — through the project's OWN
`vite.config.*` via the programmatic builder (`createBuilder().buildApp()`),
collecting the client directory and server modules with the shared
`core/Collector`.

- **`Vite.ts`** — the framework half (`make` → `Framework` service):
  `build` runs programmatic vite (or delegates wholesale to the target),
  `dev` runs vite's own dev server. A project with no SSR environment
  builds assets-only (`serverModules: undefined`).
- **`aws.ts`** — the AWS Lambda deploy target: wholesale child-process
  build (`cwd === root`), then a finishing pass that wraps the built
  server entry's fetch-shaped export in a generated streaming Lambda entry
  and rolldown re-bundles it into a self-contained `dist/lambda`.
- **`effect.ts`** — effectful (wrapper) delivery: the plain-data
  descriptor (`{ main, routes }`), the dev middleware mounting the effect
  dispatch in front of vite's dev server, and the explicit-mount
  stand-down scan.

Consumed by alchemy's `AWS.Website.Vite` SSR arm
(`ssr: true` — `packages/alchemy/src/AWS/Website/Vite.ts`).
