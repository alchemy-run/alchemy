# Static Astro File

The Static Astro File resource creates [Astro](https://astro.build/) component files with automatic directory creation and cleanup.

# Minimal Example

Create a basic Astro component file:

```ts
import { StaticAstroFile } from "alchemy/fs";

const component = await StaticAstroFile("Button.astro", `
---
const { text } = Astro.props;
---

<button>{text}</button>
`);
```

# Create with Custom Path

Create an Astro component in a specific directory:

```ts
import { StaticAstroFile } from "alchemy/fs";

const header = await StaticAstroFile("Header.astro", "src/components/Header.astro", `
---
import Logo from '../components/Logo.astro';
const navItems = ['Home', 'About', 'Contact'];
---

<header>
  <Logo />
  <nav>
    <ul>
      {navItems.map(item => (
        <li><a href={`/${item.toLowerCase()}`}>{item}</a></li>
      ))}
    </ul>
  </nav>
</header>

<style>
  header {
    padding: 1rem;
  }
</style>
`);
```