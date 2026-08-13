// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// In-workspace resolution shim (test fixture only — published-package
// users never need this): the astro build child and the dev sidecar run
// under bun, but vite resolves bare "alchemy/*" specifiers with node
// conditions, which map to the package's BUILT `lib/` output. The
// workspace fixture must exercise the current source, so every alchemy
// specifier is resolved through the bun runtime instead —
// `import.meta.resolve` honors the package's "bun" export condition,
// which maps to `src/*.ts` (vite transforms the TypeScript like any
// source module). All alchemy-internal imports are relative, so the
// whole graph stays consistently on `src/`.
const alchemyWorkspaceSrc = {
  name: "alchemy-workspace-src",
  enforce: /** @type {const} */ ("pre"),
  resolveId(/** @type {string} */ id) {
    if (id === "alchemy" || id.startsWith("alchemy/")) {
      return fileURLToPath(import.meta.resolve(id));
    }
  },
};

// On-demand SSR (required for the effectful-Website tier — a
// declared-static build would deploy assets-only and the Effect program's
// handlers could never run; the construct fails fast on that combination).
// Individual pages still opt into prerendering (`about.astro`), which is
// the effect tier's prerender guard case: the build-time prerenderer keeps
// astro's default fetchable and must build without touching the effect
// module graph.
export default defineConfig({
  output: "server",
  vite: {
    plugins: [alchemyWorkspaceSrc],
  },
});
