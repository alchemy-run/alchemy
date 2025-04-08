# Deploying a Cloudflare Worker and Static Site

## Overview

In this tutorial, you'll learn how to deploy a static website and API backend using Cloudflare Workers with Alchemy. Alchemy is a TypeScript-native Infrastructure-as-Code (IaC) library that makes it easy to deploy and manage cloud resources. By the end of this tutorial, you'll have a working Vite-based React application with a Cloudflare Worker API backend.

## Prerequisites

Before starting, make sure you have:
- A Cloudflare account with API token access
- Basic knowledge of TypeScript and React
- [Get started with Alchemy](/docs/getting-started)
- [Set up Cloudflare credentials](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

## Setup

### Create a Vite Project

First, let's create a new Vite project with React and TypeScript:

```bash
bun create vite my-cloudflare-app --template react-ts
cd my-cloudflare-app
bun install
```

## Step 1: Create the Alchemy Configuration File

Create a file named `alchemy.run.ts` in the root of your project:

```bash
touch alchemy.run.ts
```

Add the following code to initialize your Alchemy application:

```typescript
import alchemy from "alchemy";
import { KVNamespace, StaticSite, Worker } from "alchemy/cloudflare";

const app = alchemy("cloudflare-app", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});
```

This sets up the Alchemy application with a stage name based on your username and configures it to either deploy or destroy resources based on command-line arguments.

## Step 2: Create a KV Namespace for Data Storage

Add a KV Namespace to store data for your application:

```typescript
export const dataStore = await KVNamespace("DATA_STORE", {
  title: "my-app-data-store",
  values: [
    {
      key: "greeting",
      value: "Hello from Cloudflare Workers!"
    }
  ]
});
```

This creates a Cloudflare KV Namespace with an initial key-value pair that we'll access from our API.

## Step 3: Create an API Worker

Create a file for your API at `src/api.ts`:

```bash
mkdir -p src
touch src/api.ts
```

Add the following code to create a simple API:

```typescript
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';

const app = new Hono<{ Bindings: env }>();

app.get('/api/greeting', async (c) => {
  const greeting = await c.env.DATA_STORE.get('greeting');
  return c.json({ message: greeting || 'Hello, World!' });
});

export default app;
```

Now, update your `alchemy.run.ts` to create the Worker:

```typescript
export const api = await Worker("api", {
  name: "my-app-api",
  entrypoint: "./src/api.ts",
  bindings: {
    DATA_STORE: dataStore
  },
  url: true
});
```

## Step 4: Create a Type Definition File

Create an environment type definition file to ensure type safety:

```bash
touch src/env.d.ts
```

Add the following code:

```typescript
/// <reference types="./env.d.ts" />

import type { api } from "../alchemy.run";

export type CloudFlareEnv = typeof api.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudFlareEnv {}
  }
}
```

## Step 5: Deploy the Static Site

Update your `alchemy.run.ts` to deploy the static site with the API:

```typescript
export const website = await StaticSite("website", {
  name: "my-app-website",
  dir: "./dist",
  build: {
    command: "bun run build"
  },
  routes: {
    "/api/*": api
  }
});

console.log({
  url: website.url
});

await app.finalize();
```

## Testing Your Work

Now, let's update the React app to fetch data from our API. Edit `src/App.tsx`:

```typescript
import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [message, setMessage] = useState('Loading...');

  useEffect(() => {
    fetch('/api/greeting')
      .then(response => response.json())
      .then(data => setMessage(data.message))
      .catch(error => setMessage('Error loading message'));
  }, []);

  return (
    <div className="App">
      <h1>My Cloudflare App</h1>
      <p>{message}</p>
    </div>
  )
}

export default App
```

Finally, deploy your application:

```bash
bun ./alchemy.run.ts
```

After deployment completes, you should see a URL in the console output. Open that URL in your browser to see your deployed application!

To destroy the resources when you're done:

```bash
bun ./alchemy.run.ts --destroy
```

Congratulations! You've successfully deployed a static site with a Cloudflare Worker API backend using Alchemy.