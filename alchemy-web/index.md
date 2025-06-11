---
layout: home
title: Alchemy
description: Wrangle the Cloud with simple TypeScript scripts
# Custom hero component instead of the default hero
---

<CodeSnippetHero 
  name="Alchemy 🪄" 
  text="Wrangle the Cloud with simple TypeScript scripts" 
  tagline="Built-in support for Cloudflare, AWS, Stripe and more — or generate your own in minutes with AI"
  :actions="[
    { theme: 'brand', text: 'Get Started', link: '/docs/getting-started' },
    { theme: 'alt', text: 'Star on GitHub ⭐️', link: 'https://github.com/sam-goodwin/alchemy' }
  ]">
<template #code>

```typescript
const database = await D1Database("my-app-db", {
  name: "my-application-db",
});

const site = await Worker("website", {
  name: "my-app",
  bindings: {
    DB: database,
  },
});

const product = await Product("pro-plan", {
  name: "Pro Plan",
  description: "Professional subscription tier",
});
```

</template>
</CodeSnippetHero>
