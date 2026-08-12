import { defineConfig } from "tsdown";

export default defineConfig([
  {
    cwd: ".",
    entry: {
      "core/index": "src/core/index.ts",
      // Standalone child-process entry (spawned by BuildChild.ts, never
      // imported) — must keep its own stable file at dist/core/.
      "core/BuildChildRunner": "src/core/BuildChildRunner.ts",
      "astro/index": "src/astro/index.ts",
      "astro/aws": "src/astro/aws.ts",
      "astro/cloudflare": "src/astro/cloudflare.ts",
      "astro/entrypoints/aws-server": "src/astro/entrypoints/aws-server.ts",
      "astro/source": "src/astro/source.ts",
      "astro/runtime/entrypoints/server":
        "src/astro/runtime/entrypoints/server.ts",
      "astro/runtime/entrypoints/image-passthrough-endpoint":
        "src/astro/runtime/entrypoints/image-passthrough-endpoint.ts",
      "nextjs/index": "src/nextjs/index.ts",
      "nextjs/aws": "src/nextjs/aws.ts",
      "nextjs/source": "src/nextjs/source.ts",
      "aws-lambda/index": "src/aws-lambda/index.ts",
      "nuxt/index": "src/nuxt/index.ts",
      "nuxt/aws": "src/nuxt/aws.ts",
      "nuxt/cloudflare": "src/nuxt/cloudflare.ts",
      "nuxt/source": "src/nuxt/source.ts",
      "octane/index": "src/octane/index.ts",
      "octane/aws": "src/octane/aws.ts",
      "octane/aws-adapter": "src/octane/aws-adapter.ts",
      "octane/cloudflare": "src/octane/cloudflare.ts",
      "octane/source": "src/octane/source.ts",
      "sveltekit/index": "src/sveltekit/index.ts",
      "sveltekit/aws": "src/sveltekit/aws.ts",
      "sveltekit/cloudflare": "src/sveltekit/cloudflare.ts",
      "sveltekit/source": "src/sveltekit/source.ts",
      "waku/index": "src/waku/index.ts",
      "waku/adapter": "src/waku/adapter.ts",
      "waku/aws": "src/waku/aws.ts",
      "waku/aws-adapter": "src/waku/aws-adapter.ts",
      "waku/cloudflare": "src/waku/cloudflare.ts",
      "waku/source": "src/waku/source.ts",
    },
    exports: false,
    outDir: "dist",
    tsconfig: "tsconfig.node.json",
    format: "esm",
    target: "esnext",
    dts: false,
    shims: false,
    sourcemap: true,
    deps: {
      alwaysBundle: [
        /^@astrojs\/internal-helpers(?:\/|$)/,
        /^@astrojs\/underscore-redirects(?:\/|$)/,
      ],
      // Fail the build if another dependency is bundled accidentally.
      onlyBundle: [
        "@astrojs/internal-helpers",
        "@astrojs/underscore-redirects",
      ],
    },
    inputOptions: {
      external: [/^(?:astro|cloudflare|virtual):/, /^nitropack(?:\/|$)/],
      makeAbsoluteExternalsRelative: true,
    },
    outputOptions: {
      entryFileNames: "[name].js",
      chunkFileNames: "_chunks/[name]-[hash].js",
    },
  },
  {
    cwd: ".",
    entry: { "nuxt/dev/plugin": "src/nuxt/dev/plugin.ts" },
    exports: false,
    outDir: "dist",
    clean: false,
    tsconfig: "tsconfig.node.json",
    format: "esm",
    target: "esnext",
    dts: false,
    shims: false,
    sourcemap: true,
    deps: { onlyBundle: false },
    inputOptions: {
      external: [/^nitropack(?:\/|$)/],
      makeAbsoluteExternalsRelative: true,
    },
    outputOptions: {
      entryFileNames: "[name].js",
      codeSplitting: false,
    },
  },
]);
