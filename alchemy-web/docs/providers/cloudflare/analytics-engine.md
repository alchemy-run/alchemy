---
title: Cloudflare Analytics Engine
description: Learn how to bind Cloudflare Analytics Engine datasets to Workers using Alchemy for real-time event tracking and analytics.
---

# AnalyticsEngineDataset

The AnalyticsEngineDataset component lets you bind [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) datasets to your Workers for real-time event tracking and analytics data collection.

> **Note**: This is a binding-only resource that connects Workers to existing Analytics Engine datasets. It does not create or manage the datasets themselves - those must be created through the Cloudflare dashboard or Wrangler CLI.

## Minimal Example

Create a basic Analytics Engine dataset binding.

```ts
import { AnalyticsEngineDataset } from "alchemy/cloudflare";

const analytics = new AnalyticsEngineDataset("analytics", {
  dataset: "my-analytics-dataset",
});
```

## Bind to a Worker

Attach the Analytics Engine dataset to a Worker for event tracking.

```ts
import { Worker, AnalyticsEngineDataset } from "alchemy/cloudflare";

const analytics = new AnalyticsEngineDataset("analytics", {
  dataset: "user-events",
});

```ts title="./src/worker.ts"
export default {
  async fetch(request, env, ctx) {
    // Log a page view event
    env.ANALYTICS.writeDataPoint({
      blobs: ["page_view", "homepage", request.url],
      doubles: [1.0],
      indexes: [request.headers.get("cf-connecting-ip") || "unknown"]
    });
    
    return new Response("Event logged!");
  }
};
```

```ts
await Worker("event-tracker", {
  name: "event-tracker",
  entrypoint: "./src/worker.ts",
  bindings: {
    ANALYTICS: analytics,
  },
});
```
```

## Real-time Event Logging

Use Analytics Engine to track user events with structured data.

```ts
import { Worker, AnalyticsEngineDataset } from "alchemy/cloudflare";

const userEvents = new AnalyticsEngineDataset("user-events", {
  dataset: "user-interaction-events",
});

```ts title="./src/worker.ts"
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === "/api/track" && request.method === "POST") {
      try {
        const event = await request.json();
        
        // Log structured event data
        env.USER_EVENTS.writeDataPoint({
          blobs: [
            event.action || "unknown",        // Event type
            event.category || "general",      // Event category  
            event.details || "",              // Additional details
            request.headers.get("user-agent") || "unknown"
          ],
          doubles: [
            event.value || 1.0,               // Numeric value
            Date.now()                        // Timestamp
          ],
          indexes: [
            event.userId || "anonymous",      // User identifier
            request.headers.get("cf-connecting-ip") || "unknown"
          ]
        });
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: error.message 
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    return new Response("Not Found", { status: 404 });
  }
};
```

```ts
await Worker("api-server", {
  name: "api-server",
  entrypoint: "./src/worker.ts",
  bindings: {
    USER_EVENTS: userEvents,
  },
});
```
```

## E-commerce Analytics

Track purchase events and user behavior for an online store.

```ts
import { Worker, AnalyticsEngineDataset } from "alchemy/cloudflare";

const ecommerceAnalytics = new AnalyticsEngineDataset("ecommerce", {
  dataset: "store-analytics",
});

```ts title="./src/worker.ts"
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === "/api/purchase" && request.method === "POST") {
      const purchase = await request.json();
      
      // Track purchase event
      env.ANALYTICS.writeDataPoint({
        blobs: [
          "purchase",                    // Event type
          purchase.productCategory,      // Product category
          purchase.paymentMethod,        // Payment method
          purchase.country || "unknown"  // User country
        ],
        doubles: [
          purchase.amount,               // Purchase amount
          purchase.quantity || 1,        // Item quantity
          Date.now()                     // Purchase timestamp
        ],
        indexes: [
          purchase.userId,               // Customer ID
          purchase.productId,            // Product ID
          purchase.orderId               // Order ID
        ]
      });
      
      return new Response(JSON.stringify({ 
        success: true,
        orderId: purchase.orderId 
      }));
    }
    
    // Track page views
    if (request.method === "GET") {
      env.ANALYTICS.writeDataPoint({
        blobs: ["page_view", url.pathname, request.headers.get("referer") || "direct"],
        doubles: [1.0, Date.now()],
        indexes: [request.headers.get("cf-connecting-ip") || "unknown"]
      });
    }
    
    return new Response("Store API");
  }
};
```

```ts
await Worker("store-api", {
  name: "store-api",
  entrypoint: "./src/worker.ts",
  bindings: {
    ANALYTICS: ecommerceAnalytics,
  },
});
```
```

## Data Structure

For detailed information about Analytics Engine data structures (blobs, doubles, and indexes), see the [official Cloudflare Analytics Engine documentation](https://developers.cloudflare.com/analytics/analytics-engine/write-data/).

## Best Practices

### Data Organization
```ts
// Structure your data consistently
env.ANALYTICS.writeDataPoint({
  blobs: [
    eventType,        // Always first: "click", "view", "purchase"
    category,         // Event category: "button", "page", "product"  
    label,           // Specific identifier: "signup-button", "homepage"
    ...metadata      // Additional context
  ],
  doubles: [
    value,           // Primary metric (revenue, count, duration)
    timestamp,       // Event timestamp
    ...measurements  // Additional numeric data
  ],
  indexes: [
    userId,          // User identifier for filtering
    sessionId,       // Session grouping
    ...identifiers   // Other queryable fields
  ]
});
```

### Error Handling
```ts
try {
  env.ANALYTICS.writeDataPoint(eventData);
} catch (error) {
  // Analytics errors shouldn't break your application
  console.error("Analytics write failed:", error);
  // Continue with main application logic
}
```

### Performance Considerations
- Analytics Engine writes are asynchronous and non-blocking
- Each Worker can write thousands of data points per second
- Consider batching related events when possible
- Use `ctx.waitUntil()` for fire-and-forget analytics in request handlers

For dataset creation, querying, and additional configuration options, see the [official Cloudflare Analytics Engine documentation](https://developers.cloudflare.com/analytics/analytics-engine/).