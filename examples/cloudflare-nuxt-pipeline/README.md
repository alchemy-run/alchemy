# Nuxt 3 + Alchemy Basic Example

This example demonstrates deploying a basic Nuxt 3 application to Cloudflare Workers using Alchemy.

It includes:

- A simple Nuxt 3 frontend.
- A Nitro API route (`/api/pipeline`) that sends data to a Cloudflare Pipeline.
- Static asset serving via Cloudflare Workers Assets.
- Configuration using `alchemy.run.ts`.

## Setup

1.  **Install Dependencies:** Navigate to the root of the Alchemy repository and run:
    ```bash
    bun install
    ```
    This will install dependencies for the core library and all examples, including this one.

2.  **Cloudflare Credentials:** Ensure you have your Cloudflare API token and Account ID configured as environment variables:
    ```bash
    export CLOUDFLARE_API_TOKEN="your_api_token"
    export CLOUDFLARE_ACCOUNT_ID="your_account_id"
    ```
    You can also place these in a `.env` file in the repository root.

## Running the Deployment

1.  **Navigate to Example Directory:**
    ```bash
    cd examples/nuxt3-basic
    ```

2.  **Run Alchemy Deployment:**
    ```bash
    bun run deploy
    ```
    Or directly:
    ```bash
    bun ../../src/cli.ts run
    ```

This command will:

- Execute the `bun run build` script defined in `alchemy.run.ts` to build the Nuxt application.
- Provision the Cloudflare Pipeline queue (`nuxt3-pipeline-demo`).
- Upload the static assets from `./.output/public` to Cloudflare Workers Assets.
- Deploy the Cloudflare Worker (`nuxt3-basic-worker`) using the entrypoint `./.output/server/index.mjs`.
- Bind the Assets service and Pipeline queue to the worker.
- Output the URL of the deployed worker.

## Development

To run the Nuxt development server locally:

1.  Navigate to the example directory:
    ```bash
    cd examples/nuxt3-basic
    ```
2.  Run the development server:
    ```bash
    bun run dev
    ```

Note: The `/api/pipeline` route will not function correctly in the local development environment as it relies on Cloudflare environment bindings injected by Alchemy during deployment.

## Cleanup

To destroy the Cloudflare resources created by this example, run:

```bash
cd examples/nuxt3-basic
bun ../../src/cli.ts destroy
```
