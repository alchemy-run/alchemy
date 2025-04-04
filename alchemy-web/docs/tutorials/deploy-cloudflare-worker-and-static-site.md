# Deploying a Cloudflare Worker and Static Site (5 minutes)

## Overview
Learn how to deploy a simple static website with a Cloudflare Worker API endpoint using Alchemy.

## Prerequisites
- Node.js 16+ installed
- Bun installed (`npm install -g bun`) 
- Cloudflare account
- Basic command line knowledge

## Step 1: Setup (2 minutes)

Create project and install dependencies:
```bash
# Create project directory
mkdir cloudflare-site && cd cloudflare-site

# Initialize project
bun init -y

# Install Alchemy
bun add alchemy @types/node
```

Get your Cloudflare credentials:
1. Go to Cloudflare Dashboard
2. Click "API Tokens" under "My Profile"
3. Create token with "Edit Workers" permissions
4. Copy the Account ID from dashboard overview

Create `.env` file:
```bash
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

## Step 2: Create Site Files (1 minute)

Create static site content:
```bash
# Create dist directory
mkdir dist

# Create index.html
echo "<h1>Hello from Static Site!</h1>" > dist/index.html
```

## Step 3: Create Deployment Script (1 minute)

Create `alchemy.run.ts`:
```typescript
import "@types/node";
import alchemy from "alchemy";
import { Worker, StaticSite } from "alchemy/cloudflare";

// Initialize Alchemy
const app = alchemy("cloudflare-site", {
  stage: "dev" // Development environment
});

// Create API worker
export const api = await Worker("api", {
  name: "my-first-api",
  script: `
    export default {
      async fetch() {
        return new Response('Hello from Worker!');
      }
    }
  `
});

// Create static site with API route
export const website = await StaticSite("website", {
  name: "my-first-site",
  dir: "./dist",
  routes: {
    "/api/*": api
  }
});

// Print deployment URL
console.log(`Site URL: ${website.url}`);
await app.finalize();
```

## Step 4: Deploy (1 minute)

Deploy your site:
```bash
bun run alchemy.run.ts
```

Once complete, visit the URL printed in the console to see your site. Test the API by adding `/api` to the URL.

That's it! You've deployed a static site with a serverless API endpoint.