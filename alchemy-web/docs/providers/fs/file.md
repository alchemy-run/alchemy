# File Resource

The File Resource lets you create and manage files in the filesystem with automatic directory creation and cleanup.

## Minimal Example

Creates a simple text file with content.

```ts
import { File } from "alchemy/fs";

const config = await File("config.txt", {
  path: "config.txt", 
  content: "some configuration data"
});
```

## Create File in Nested Directory

```ts
import { File } from "alchemy/fs";

const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});
```

## Update File Path and Content

```ts
import { File } from "alchemy/fs";

let file = await File("config.json", {
  path: "config.json",
  content: '{ "version": "1.0.0" }'
});

// Later update path and content (old file will be removed)
file = await File("config.json", {
  path: "config/config.json", 
  content: '{ "version": "1.0.1" }'
});
```

## Static File Types

The File Resource includes specialized static file types for common formats:

```ts
import { 
  StaticAstroFile,
  StaticCSSFile,
  StaticHTMLFile,
  StaticJsonFile,
  StaticTextFile,
  StaticTypeScriptFile,
  StaticVueFile,
  StaticYamlFile
} from "alchemy/fs";

// Create typed files with proper formatting
const styles = await StaticCSSFile("styles.css", ".container { max-width: 1200px; }");
const config = await StaticJsonFile("config.json", { version: "1.0.0" });
const component = await StaticVueFile("Button.vue", "<template><button>{{ text }}</button></template>");
```