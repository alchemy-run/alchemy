# Pipeline

The Pipeline resource lets you create [Cloudflare Pipeline](https://developers.cloudflare.com/pipelines/) data pipelines for collecting, transforming and routing data to destinations like R2 buckets.

# Minimal Example

Create a basic pipeline that routes data to an R2 bucket:

```ts
import { Pipeline, R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("logs-bucket", {
  name: "logs-bucket"
});

const pipeline = await Pipeline("logs-pipeline", {
  name: "logs-pipeline", 
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: bucket.name,
      prefix: "app-logs"
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID!),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY!)
    }
  }
});
```

# Custom Source Configuration

Configure custom HTTP source with CORS and authentication:

```ts
import { Pipeline } from "alchemy/cloudflare";

const pipeline = await Pipeline("custom-pipeline", {
  name: "custom-pipeline",
  source: [{
    type: "http",
    format: "json", 
    authentication: true,
    cors: {
      origins: ["https://example.com"]
    }
  }],
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: "my-bucket",
      prefix: "data"
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID!),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY!)
    }
  }
});
```

# Batch Configuration

Configure batching behavior for pipeline output:

```ts
import { Pipeline } from "alchemy/cloudflare";

const pipeline = await Pipeline("batch-pipeline", {
  name: "batch-pipeline",
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: "my-bucket"
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID!),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY!)
    },
    batch: {
      maxMb: 50,
      maxRows: 1000000,
      maxSeconds: 60
    }
  }
});
```

# Bind to a Worker

Use the pipeline in a Cloudflare Worker:

```ts
import { Worker, Pipeline } from "alchemy/cloudflare";

const pipeline = await Pipeline("logs", {
  name: "logs-pipeline",
  destination: {
    type: "r2",
    format: "json",
    path: {
      bucket: "logs"
    },
    credentials: {
      accessKeyId: alchemy.secret(process.env.R2_ACCESS_KEY_ID!),
      secretAccessKey: alchemy.secret(process.env.R2_SECRET_ACCESS_KEY!)
    }
  }
});

await Worker("api", {
  name: "api-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    LOGS: pipeline
  }
});
```