---
order: 4 # Adjust order as needed
---

# Cloudflare Nuxt 3 & Cloudflare Pipeline

This guide walks through deploying a full-stack Nuxt 3 application with a backend Pipeline to Cloudflare using Alchemy and `Nuxt`.

## Create the Nuxt 3 Project

Start by creating a new Nuxt 3 project:

```sh
bun create nuxt-app 
bun install
```

Install alchemy and Cloudflare types:

```sh
bun add alchemy cloudflare
```

## Configure `nuxt.config.ts` for Cloudflare

Configure `nuxt.config.ts` for the `cloudflare-module` preset:

```typescript
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-04-21", // Example date, use current recommended
  devtools: { enabled: true },
  nitro: {
    // Must use the cloudflare-module preset for Nuxt to work correctly
    preset: "cloudflare-module",
    prerender: {
      routes: ["/"], // Prerender root for static hosting part
      autoSubfolderIndex: false,
    },
  },
});
``` 

## Create `alchemy.run.ts`

Create the `alchemy.run.ts` script in the root of the Nuxt 3 project.

```typescript
// ./alchemy.run.ts
import alchemy from "alchemy";
import { Pipeline, R2Bucket, Nuxt } from "alchemy/cloudflare";

const R2_BUCKET_NAME = "example-bucket";
const PIPELINE_NAME = "example-pipeline";

const app = await alchemy("app", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: !process.argv.includes("--verbose"),
  password: process.env.ALCHEMY_PASS,
});

const bucket = await R2Bucket("bucket", {
  name: R2_BUCKET_NAME,
});

const pipeline = await Pipeline("pipeline", {
  name: PIPELINE_NAME,
  source: [{ type: "binding", format: "json" }],
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: bucket.name,
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY),
    },
    batch: {
      maxMb: 10,
      // testing value. recommended - 300
      maxSeconds: 5,
      maxRows: 100,
    },
  },
});

export const website = await Nuxt("website", {
  // command: "bun run build", // Defaulted by Nuxt
  // main: "./index.ts", // Defaulted by Nuxt
  // assets: "./.output/public/", // Defaulted by Nuxt
  bindings: {
    R2_BUCKET: bucket,
    PIPELINE: pipeline,
  },
});

console.log({
  url: website.url,
});

await app.finalize(); // must be at end

```

> [!NOTE]
> - Ensure `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` environment variables are set for the pipeline. You can generate these from your Cloudflare dashboard under R2 -> Manage R2 API Tokens. See the [Cloudflare R2 API Tokens documentation](https://developers.cloudflare.com/r2/api/tokens/) for more details.
> - Ensure the `ALCHEMY_PASSWORD` environment variable is set. This password is used by Alchemy to encrypt sensitive values like your R2 secret access key.

## Create API Route to Use Pipeline

Create `server/api/pipeline.post.ts` to interact with the pipeline binding:

```typescript
// ./server/api/pipeline.post.ts
import { env } from "cloudflare:workers";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);
    const pipeline = env.PIPELINE;
    const data = body.data;

    if (!data) {
      throw new Error("Missing 'data' property in request body");
    }

    // Always send data wrapped in an array
    await pipeline.send([{ value: data }]);

    return { success: true, message: "Data sent to pipeline." };
  } catch (error) {
    console.error("Error sending data to pipeline:", error);
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : "Pipeline error",
    });
  }
});
```

## Create Frontend Page (Example)

Update `pages/index.vue` (or `app.vue`) to include a form that calls the API route.

```vue
<!-- ./pages/index.vue -->
<template>
  <div>
    <h1>Nuxt 3 + Alchemy + Cloudflare Pipeline Demo</h1>
    <form @submit.prevent="sendToPipeline">
      <label for="dataInput">Data to send:</label>
      <input id="dataInput" v-model="dataToSend" type="text" required />
      <button type="submit" :disabled="loading">Send to Pipeline</button>
    </form>
    <p v-if="message">{{ message }}</p>
    <p v-if="error" style="color: red">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const dataToSend = ref("");
const loading = ref(false);
const message = ref("");
const error = ref("");

async function sendToPipeline() {
  loading.value = true;
  message.value = "";
  error.value = "";

  try {
    const response = await fetch("/api/pipeline", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: dataToSend.value }),
    });

    const result = (await response.json()) as {
      message?: string;
      statusMessage?: string;
    };

    if (!response.ok) {
      throw new Error(result.statusMessage || "Failed to send data");
    }

    message.value = result.message || "Data sent successfully!";
    dataToSend.value = ""; // Clear input after success
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : "An unknown error occurred.";
    console.error("Error sending to pipeline:", err);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 300px;
  margin-top: 20px;
}
label {
  font-weight: bold;
}
input {
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
}
button {
  padding: 10px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}
</style>
```

## Infer Binding Types

Create an `env.d.ts` file in the project root to get type hints for the Cloudflare bindings (`PIPELINE`, `R2_BUCKET`).

```typescript
// ./env.d.ts
/// <reference types="@cloudflare/workers-types" />

// Import the type from the exported Nuxt resource
import type { website } from './alchemy.run';

// Define the environment type based on the Nuxt bindings
export type WorkerEnv = typeof website.Env;

declare module 'cloudflare:workers' {
  // Extend the global Cloudflare Env interface
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

## Deploy Application

Ensure your Cloudflare credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and R2 credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are set.

> [!NOTE]
> - You can generate R2 API Tokens from your Cloudflare dashboard under R2 -> Manage R2 API Tokens. See the [Cloudflare R2 API Tokens documentation](https://developers.cloudflare.com/r2/api/tokens/) for more details.
> - Ensure the `ALCHEMY_PASSWORD` environment variable is set. This password is used by Alchemy to encrypt sensitive values like your R2 secret access key.


Run the `alchemy.run.ts` script:

```sh
bun ./alchemy.run
```

This will:
1. Build the Nuxt application (`bun run build`).
2. Provision the R2 bucket and Pipeline on Cloudflare.
3. Deploy the Nuxt application (server and static assets).
4. Output the URL of your deployed application.

```text
{
  url: "https://your-site.your-account.workers.dev" // Example URL
}
```
Click the URL to see your site. Test sending data via the form; it should appear in your R2 bucket shortly after.

## Tear Down

To delete the Cloudflare resources created by this guide, run:

```sh
bun ./alchemy.run.ts --destroy
``` 