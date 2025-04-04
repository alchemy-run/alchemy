# Deploying a Cloudflare Worker and Static Site

## Overview
This tutorial will guide you through deploying a React application with a Cloudflare Worker backend using Alchemy. You'll create a static site hosted on Cloudflare Pages and a Worker API to serve data from KV storage.

## Prerequisites
- Node.js installed
- Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- Cloudflare account with API token
- Basic knowledge of React and TypeScript

## Setup

### Installation
```bash
# Create new Vite project
bun create vite my-alchemy-app --template react-ts

# Install dependencies 
cd my-alchemy-app
bun install

# Add Alchemy
bun add alchemy
```

### Configuration
Create a `.env` file with your Cloudflare credentials:

```bash
CLOUDFLARE_API_TOKEN=your_api_token
CLOUDFLARE_ACCOUNT_ID=your_account_id
```

## Step 1: Create the Alchemy Run Script

Create `alchemy.run.ts` in your project root:

```typescript
import alchemy from "alchemy";
import { KVNamespace, StaticSite, Worker } from "alchemy/cloudflare";

const app = alchemy("my-app");

// Create KV namespace for data storage
export const db = await KVNamespace("DB", {
  title: "my-app-db",
  values: [
    { key: "message", value: "Hello from KV!" }
  ]
});

// Create API worker
export const api = await Worker("api", {
  name: "my-app-api",
  entrypoint: "./src/api.ts",
  bindings: {
    DB: db
  }
});

// Create static site
export const website = await StaticSite("Website", {
  name: "my-app",
  dir: "./dist",
  build: {
    command: "bun run build"
  },
  routes: {
    "/api/*": api
  }
});

console.log({ url: website.url });

await app.finalize();
```

## Step 2: Create the API Worker

Create `src/api.ts`:

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/api/message", async (c) => {
  const message = await c.env.DB.get("message");
  return c.json({ message });
});

export default app;
```

## Step 3: Add Environment Type Definitions

Create `src/env.d.ts`:

```typescript
import type { api } from "../alchemy.run";

export type CloudFlareEnv = typeof api.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudFlareEnv {}
  }
}
```

## Step 4: Update React App

Update `src/App.tsx`:

```typescript
import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetch('/api/message')
      .then(res => res.json())
      .then(data => setMessage(data.message))
  }, [])

  return (
    <div>
      <h1>Message from KV:</h1>
      <p>{message}</p>
    </div>
  )
}

export default App
```

## Step 5: Deploy the Application

Run the Alchemy script to deploy:

```bash
bun ./alchemy.run.ts
```

You should see output like:
```
{
  url: "https://my-app.username.workers.dev"
}
```

## Testing Your Work
Visit the URL output by the script. You should see:
- The React app loaded
- The message "Hello from KV!" displayed from the API

## Troubleshooting

Common issues:
- API token permissions - ensure your token has Workers and KV access
- Build errors - check the Vite build output
- API 404s - verify the routes in alchemy.run.ts

## Next Steps

- Add more KV data and API endpoints
- Configure custom domains
- Add authentication to your API
- Set up CI/CD with GitHub Actions

## Additional Resources

- [Alchemy Documentation](https://github.com/sam/alchemy)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Hono Documentation](https://honojs.dev/)