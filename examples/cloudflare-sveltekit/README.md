# Cloudflare SvelteKit Example

This example demonstrates how to deploy a SvelteKit application to Cloudflare Workers using Alchemy's infrastructure-as-code approach.

## Features

- 🚀 SvelteKit app deployed to Cloudflare Workers
- 📦 KV Namespace for key-value storage
- 🗄️ R2 Bucket for object storage
- 🔧 Alchemy-managed infrastructure
- 💻 TypeScript support with Cloudflare Workers types

## Prerequisites

1. [Bun](https://bun.sh/) installed
2. Cloudflare account with API token
3. Environment variables configured (see below)

## Environment Setup

Create a `.env` file in the project root (`../../.env` relative to this directory) with:

```bash
# Cloudflare API credentials
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id

# Optional: Alchemy configuration
ALCHEMY_PASSWORD=your_encryption_password
BRANCH_PREFIX=your_branch_prefix
USER=your_username
```

## Getting Started

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Run the development server:**
   ```bash
   bun run dev
   ```

3. **Deploy to Cloudflare:**
   ```bash
   bun run deploy
   ```

4. **Destroy resources:**
   ```bash
   bun run destroy
   ```

## Project Structure

```
├── src/
│   ├── routes/
│   │   ├── +page.svelte          # Main demo page
│   │   └── +page.server.ts       # Server-side logic with Cloudflare bindings
│   ├── app.d.ts                  # Type definitions for Cloudflare Platform
│   └── app.html                  # HTML template
├── alchemy.run.ts                # Alchemy infrastructure definition
├── svelte.config.js              # SvelteKit config with Cloudflare adapter
└── package.json
```

## Infrastructure Resources

The Alchemy configuration creates:

- **KV Namespace**: `cloudflare-sveltekit-auth-store{BRANCH_PREFIX}`
- **R2 Bucket**: `cloudflare-sveltekit-storage{BRANCH_PREFIX}`
- **Cloudflare Worker**: Hosts the SvelteKit application

## How It Works

1. **SvelteKit Configuration**: Uses `@sveltejs/adapter-cloudflare` to build for Cloudflare Workers
2. **Alchemy Infrastructure**: Defines KV and R2 resources in `alchemy.run.ts`
3. **Bindings**: Resources are automatically bound to the worker environment
4. **Server-side Logic**: `+page.server.ts` demonstrates using the Cloudflare bindings
5. **Type Safety**: Full TypeScript support with Cloudflare Workers types

## Development vs Production

- **Development**: Run `bun run dev` for local development with Vite
- **Production**: Deploy with `bun run deploy` to create real Cloudflare resources

## Customization

### Adding More Resources

Edit `alchemy.run.ts` to add additional Cloudflare resources:

```typescript
// Add a D1 Database
const database = await D1Database("my-database", {
  name: `my-app-db${BRANCH_PREFIX}`
});

// Add to bindings
export const website = await SvelteKit(`cloudflare-sveltekit-website${BRANCH_PREFIX}`, {
  bindings: {
    STORAGE: storage,
    AUTH_STORE: authStore,
    DATABASE: database, // Add the new resource
  },
});
```

### Updating Types

Update `src/app.d.ts` to include new bindings:

```typescript
interface Platform {
  env: {
    STORAGE: R2Bucket;
    AUTH_STORE: KVNamespace;
    DATABASE: D1Database; // Add new binding type
  };
  context: ExecutionContext;
  caches: CacheStorage & { default: Cache };
}
```

## Learn More

- [SvelteKit Documentation](https://svelte.dev/docs/kit)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Alchemy Documentation](https://alchemy.run)
- [@sveltejs/adapter-cloudflare](https://www.npmjs.com/package/@sveltejs/adapter-cloudflare)

## Troubleshooting

### Build Issues

If you encounter build issues, try:
1. `bun install` to ensure all dependencies are installed
2. `bun run check` to verify TypeScript types
3. Check that the Cloudflare adapter is properly configured

### Deployment Issues

If deployment fails:
1. Verify your Cloudflare API token has the necessary permissions
2. Check that your account ID is correct
3. Ensure you're not hitting Cloudflare's free tier limits

### Type Errors

Some TypeScript errors are expected during development until SvelteKit generates the types. Run `svelte-kit sync` to generate missing types.
