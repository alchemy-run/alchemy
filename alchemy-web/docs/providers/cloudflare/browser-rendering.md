---
title: Managing Cloudflare Browser Rendering with Alchemy
description: Learn how to use Cloudflare Browser Rendering with Alchemy for taking screenshots and automating browser tasks at the edge.
---

# BrowserRendering

[Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) allows you to run a full browser instance within your Worker to take screenshots, generate PDFs, and automate browser tasks.

## Minimal Example

Create a basic Worker with browser rendering capabilities:

```ts
import { Worker, BrowserRendering } from "alchemy/cloudflare";

const worker = await Worker("browser-worker", {
  name: "browser-worker",
  entrypoint: "./src/browser.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    BROWSER: new BrowserRendering()
  }
});
```

## With KV Caching

Create a Worker that takes screenshots and caches them in KV storage:

```ts
import { Worker, BrowserRendering, KVNamespace } from "alchemy/cloudflare";

const cache = await KVNamespace("screenshot-cache", {
  title: "Screenshot Cache"
});

const worker = await Worker("screenshot-service", {
  name: "screenshot-service",
  entrypoint: "./src/screenshot.ts",
  compatibilityFlags: ["nodejs_compat"],
  url: true,
  bindings: {
    BROWSER: new BrowserRendering(),
    CACHE: cache
  },
  bundle: {
    platform: "node"
  }
});
```

The Worker handler can use Puppeteer to control the browser:

```ts
// src/screenshot.ts
import puppeteer from "@cloudflare/puppeteer";

export default {
  async fetch(request: Request, env: any) {
    const { searchParams } = new URL(request.url);
    let url = searchParams.get("url");
    let img;

    if (url) {
      url = new URL(url).toString();
      img = await env.CACHE.get(url, { type: "arrayBuffer" });

      if (img === null) {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.goto(url);
        img = await page.screenshot();

        await env.CACHE.put(url, img, {
          expirationTtl: 60 * 60 * 24,
        });

        await browser.close();
      }

      return new Response(img, {
        headers: {
          "content-type": "image/jpeg",
        },
      });
    } else {
      return new Response("Please add an ?url=https://example.com/ parameter");
    }
  },
};
```

## Bind to a Worker

Use browser rendering as a binding in another Worker:

```ts
import { Worker, BrowserRendering } from "alchemy/cloudflare";

const browserService = new BrowserRendering();

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    BROWSER: browserService
  }
});
```
