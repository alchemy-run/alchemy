# Upload Asset Manifest

The Upload Asset Manifest resource allows you to manage the upload of asset manifests to Cloudflare's KV storage. This is useful for deploying static assets with specific cache control and content type settings. For more information, visit [Cloudflare's documentation](https://developers.cloudflare.com/workers/learning/how-kv-works).

# Minimal Example

```ts
import { uploadAssetManifest } from "alchemy/cloudflare";

const api = await createCloudflareApi();
const namespaceId = "your-namespace-id";
const manifest = [
  {
    source: "path/to/asset.js",
    key: "asset.js",
    hash: "abc123",
    cacheControl: "max-age=31536000",
    contentType: "application/javascript",
  },
];

await uploadAssetManifest(api, namespaceId, manifest);
```

# Create the Upload Asset Manifest

```ts
import { uploadAssetManifest } from "alchemy/cloudflare";

const api = await createCloudflareApi();
const namespaceId = "your-namespace-id";
const manifest = [
  {
    source: "path/to/asset.css",
    key: "asset.css",
    hash: "def456",
    cacheControl: "max-age=31536000",
    contentType: "text/css",
  },
];

await uploadAssetManifest(api, namespaceId, manifest);
```

# Bind to a Worker

```ts
import { Worker, uploadAssetManifest } from "alchemy/cloudflare";

const api = await createCloudflareApi();
const namespaceId = "your-namespace-id";
const manifest = [
  {
    source: "path/to/asset.png",
    key: "asset.png",
    hash: "ghi789",
    cacheControl: "max-age=31536000",
    contentType: "image/png",
  },
];

await uploadAssetManifest(api, namespaceId, manifest);

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    ASSETS: namespaceId,
  },
});
```