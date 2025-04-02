# Generate Asset Manifest

The Generate Asset Manifest component allows you to create an asset manifest for your Cloudflare application. This manifest is used to manage and optimize the caching and delivery of static assets. For more information, visit the [Cloudflare documentation](https://developers.cloudflare.com).

# Minimal Example

```ts
import { generateAssetManifest } from "alchemy/cloudflare";

const manifest = await generateAssetManifest("./public");
console.log(manifest);
```

# Create the Generate Asset Manifest

```ts
import { generateAssetManifest } from "alchemy/cloudflare";

const manifest = await generateAssetManifest("./public", [
  {
    files: "**",
    cacheControl: "max-age=0,no-cache,no-store,must-revalidate",
  },
  {
    files: ["**/*.js", "**/*.css"],
    cacheControl: "max-age=31536000,public,immutable",
  },
]);
console.log(manifest);
```

# Bind to a Worker

```ts
import { Worker, generateAssetManifest } from "alchemy/cloudflare";

const assetManifest = await generateAssetManifest("./public", {
  // ...
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    assetManifest,
  },
});
```