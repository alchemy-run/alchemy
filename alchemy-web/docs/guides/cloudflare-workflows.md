---
order: 5
title: Workflows
description: Create, bind, and trigger Cloudflare Workflows from your Alchemy-managed Worker applications. Learn how to orchestrate complex processes serverlessly.
---

# Workflow

This guide explains how to create, bind and use Cloudflare Workflows within your Worker scripts.

> [!TIP]
> We assume you're familiar with Cloudflare Workflows already. If not, read [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) first.

## Create a Workflow

At a bare minimum, you need to create a `Workflow` object as a stable reference to your Workflow.

```ts
import { Workflow } from "alchemy/cloudflare";

const orderProcessor = new Workflow("orderProcessor");
```

If you're paying close attention, you'll notice that we call `new Workflow` instead of `await Workflow` like you might have come to expect from Alchemy Resources.

This is because of oddities in Cloudflare's API design. Workflows are not resources in the traditional sense because they cannot exist without a Worker.

## Bind the Workflow to a Worker

Instead, you create a Workflow object and then bind it to your Worker:

```ts
export const worker = await Worker("Worker", {
  name: "my-worker",
  entrypoint: "./index.ts"
  bindings: {
    // bind the workflow to your Worker
    ORDER_PROCESSOR: orderProcessor,
  },
});
```

## Implement the Workflow class

Now, we have a Worker with a Workflow running within it. To use this Workflow, our Worker script must include a class for the workflow and then some code in the `fetch` handler to trigger it.

A simple workflow may look like so:

```ts
export class OrderProcessor extends WorkflowEntrypoint {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async run(event, step) {
    const shippingDetails = await step.do("process-shipping", async () => {
      return {
        success: true,
        shipmentId: event.payload.shipmentId,
        message: "Shipment scheduled successfully",
      };
    });
    return shippingDetails;
  }
}
```

> [!TIP]
> See Cloudflare's [Workflow Guide](https://developers.cloudflare.com/workflows/get-started/guide/) for more details on implementing workflows.

## Trigger the Workflow from your Worker

Now, our `fetch` handler can create a Workflow instance (start a workflow) via the `ORDER_PROCESSOR` binding:

```ts
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const params = { orderId: "test-123", amount: 99.99 };
    const instance = await env.ORDER_PROCESSOR.create(params);

    return Response.json({
      id: instance.id,
      details: await instance.status(),
      success: true,
      orderId: params.orderId,
      message: "Order processed successfully",
    });
  },
};
```

## Type-safe Bindings

Remember, for `env.` to be type-safe, you need to configure your `src/env.d.ts` to infer the types from your worker:

```ts
// src/env.d.ts
import type { worker } from "./alchemy.run";

export type WorkerEnv = typeof worker.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

> [!TIP]
> See the [Bindings](../concepts/bindings.md) for more information.