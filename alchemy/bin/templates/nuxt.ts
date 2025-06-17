import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../types.ts";
import { create } from "../utils.ts";
import { initWebsiteProjectWithContext } from "./index.ts";

export default async function initNuxtProject(
  context: ProjectContext,
): Promise<void> {
  try {
    create(
      context,
      `cloudflare@2.49.3 ${context.name} --framework=nuxt --no-git --no-deploy ${context.options.yes ? "--yes" : ""}`,
    );

    await initWebsiteProjectWithContext(context, {
      scripts: {
        build: "nuxt build",
      },
    });

    try {
      await fs.writeFile(
        join(context.path, "nuxt.config.ts"),
        `export default defineNuxtConfig({
  devtools: { enabled: true },
  nitro: {
    preset: 'cloudflare-pages'
  },
  ssr: true
})
`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create nuxt.config.ts: ${errorMsg}`);
    }

    try {
      await fs.writeFile(
        join(context.path, "app.vue"),
        `<template>
  <div>
    <h1>Welcome to Nuxt on Cloudflare!</h1>
    <p>Your Nuxt app is running on Cloudflare Workers with Alchemy.</p>
  </div>
</template>

<style>
div {
  text-align: center;
  padding: 2rem;
}

h1 {
  color: #00dc82;
  font-size: 3rem;
  margin-bottom: 1rem;
}

p {
  font-size: 1.2rem;
  color: #4a5568;
}
</style>
`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update app.vue: ${errorMsg}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Nuxt template initialization failed: ${errorMsg}`);
  }
}
