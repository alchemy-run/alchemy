---
layout: home
title: Alchemy
description: Like Terraform but in plain TypeScript
# Custom hero component instead of the default hero
---

<CodeSnippetHero 
  name="Alchemy" 
  text="Wrangle the Cloud with pure TypeScript 🪄" 
  tagline="Built-in support for Cloudflare, AWS, Stripe and more — or generate your own in minutes with our llms.txt"
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
