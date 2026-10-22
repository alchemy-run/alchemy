# Azure Website: Vite

A Tailwind React SPA deployed with `Azure.Website.Vite` to Azure Container
Apps. Alchemy creates a resource group, a Basic Azure Container Registry, an
Express Container Apps environment, and a Container App; the built site is
packaged into an image with your local Docker daemon and pushed to the
registry.

- `alchemy deploy` builds the SPA and serves it at `https://{app}.{env}.{region}.azurecontainerapps.io`.
- `alchemy dev` is Vite's own server (HMR included).

Requires a running Docker daemon and an Azure profile (`alchemy login azure`).

```sh
bun run deploy
bun run destroy
```
