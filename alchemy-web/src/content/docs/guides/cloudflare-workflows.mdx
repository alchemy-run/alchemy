---
title: Workflow
description: Create, bind, and trigger Cloudflare Workflows from your Alchemy-managed Worker applications. Learn how to orchestrate complex processes serverlessly.
sidebar:
  order: 1.2
---

import { Steps } from '@astrojs/starlight/components';

This guide explains how to create, bind and use Cloudflare Workflows within your Worker scripts.

<Steps>

1. **Create a Workflow**

   At a bare minimum, you need to create a `Workflow` object as a stable reference to your Workflow.

   ```ts
   import { Workflow } from "alchemy/cloudflare";

   const orderProcessor = Workflow("orderProcessor", {
     className: "OrderProcessor",
     // defaults to the resource ID ("orderProcessor") if not specified
     // workflowName: "order-processing-workflow",
   });
   ```

2. **Bind the Workflow to a Worker**

   Create a Worker and bind your workflow to it so it can be accessed from your Worker script.

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

3. **Implement the Workflow class**

   Now, we have a Worker with a Workflow running within it. To use this Workflow, our Worker script must include a class for the workflow.

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

   :::tip
   See Cloudflare's [Workflow Guide](https://developers.cloudflare.com/workflows/get-started/guide/) for more details on implementing workflows.
   :::

4. **Trigger the Workflow from your Worker**

   Now, our `fetch` handler can create a Workflow instance (start a workflow) via the `ORDER_PROCESSOR` binding:

   ```ts
   import type { worker } from "./alchemy.run";

   export default {
     async fetch(request: Request, env: typeof worker.Env) {
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

5. **(Optional) Rename the Class**

   Alchemy takes care of migrations automatically when you rename the class name.

   ```diff lang='ts'
    import { Workflow } from "alchemy/cloudflare";

    const orderProcessor = Workflow("orderProcessor", {
   -  className: "OrderProcessor",
   +  className: "OrderProcessorV2",
    });
   ```

   :::caution
   You cannot rename the `"orderProcessor"` ID in `Workflow("orderProcessor")` - we call this the "stable identifier" for the Workflow and it is immutable for the lifetime of the application.
   :::

6. **(Optional) Set up Cross-Script Workflow Binding**

   You can share workflows across multiple Workers, allowing one Worker to trigger workflows defined in another Worker. This is useful for creating modular architectures where different Workers handle different concerns.

</Steps>
