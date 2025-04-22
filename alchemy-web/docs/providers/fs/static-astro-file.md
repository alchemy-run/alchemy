# StaticAstroFile

The StaticAstroFile resource creates [Astro component files](https://docs.astro.build/en/core-concepts/astro-components/) with proper formatting and directory structure.

# Minimal Example

Creates a basic Astro component file.

```ts
import { StaticAstroFile } from "alchemy/fs";

const component = await StaticAstroFile("Header.astro", `
---
const title = "Hello World";
---

<h1>{title}</h1>
`);
```

# Custom Path

Creates an Astro component in a specific directory.

```ts
import { StaticAstroFile } from "alchemy/fs";

const component = await StaticAstroFile("header", 
  "src/components/Header.astro",
  `---
  import Logo from '../components/Logo.astro';
  const navItems = ['Home', 'About', 'Contact'];
  ---
  
  <header>
    <Logo />
    <nav>
      {navItems.map(item => (
        <a href={`/${item.toLowerCase()}`}>{item}</a>
      ))}
    </nav>
  </header>
`);
```