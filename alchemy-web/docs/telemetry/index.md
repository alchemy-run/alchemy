---
title: Telemetry
order: 1
---

# Telemetry

Alchemy collects anonymous usage telemetry to help us understand how the tool is being used and improve the developer experience. This data helps us prioritize features, identify bugs, and optimize performance.

## What Data Is Collected

### Events Tracked

Alchemy tracks the following events during execution:

- **`app.start`** - When an Alchemy application begins running
- **`app.success`** - When an application completes successfully  
- **`app.error`** - When an application encounters an error
- **`resource.start`** - When a resource begins provisioning
- **`resource.success`** - When a resource is successfully created/updated
- **`resource.error`** - When a resource encounters an error
- **`resource.skip`** - When a resource is skipped (e.g., already exists)
- **`resource.read`** - When a resource is read from the cloud provider

### Event Properties

Each event may include additional properties:

- **Elapsed time** - For `*.success` and `*.error` events, the time taken to complete
- **Resource information** - For `resource.*` events, includes resource name and status
- **Error details** - For `resource.error` events, includes serialized error information (with sensitive data redacted)

### Metadata

All events include the following metadata:

- **Anonymous user ID** - A randomly generated identifier stored locally in your system's configuration directory
- **Anonymous project ID** - Derived from your project's root git commit hash
- **System information** - Operating system, version, architecture, CPU count, and memory
- **Runtime details** - JavaScript runtime name and version (e.g., workerd, Bun 1.2.15, Node 22.15.0)
- **CI provider** - If running in a CI environment (e.g., GitHub Actions)
- **Alchemy version and phase** - The version of Alchemy being used and deployment phase

## Privacy

Your privacy is important to us:

- **No personal information** - We do not collect usernames, email addresses, or other personally identifiable information
- **Local storage** - Your anonymous user ID is stored locally in your system's configuration directory
- **Data redaction** - Home directory paths are automatically redacted from stack traces and error messages
- **Anonymous identifiers** - Project IDs are derived from git commit hashes, not repository names or URLs

### First-Time Warning

When Alchemy runs for the first time on your system, you'll see a warning message explaining that an anonymous user ID has been generated. This only happens once per system.

## How to Opt Out

You can disable telemetry collection at any time using environment variables:

### Option 1: Alchemy-Specific Variable

```bash
export ALCHEMY_TELEMETRY_DISABLED=1
```

### Option 2: Universal Do Not Track

Alchemy respects the [Do Not Track](https://consoledonottrack.com) standard:

```bash
export DO_NOT_TRACK=1
```

### Permanent Opt-Out

To permanently disable telemetry, add either environment variable to your shell profile:

```bash
# In ~/.bashrc, ~/.zshrc, or equivalent
echo 'export ALCHEMY_TELEMETRY_DISABLED=1' >> ~/.bashrc
```

## Data Usage

The telemetry data helps us:

- **Identify popular features** - Understand which Alchemy features are most commonly used
- **Detect errors** - Find and fix bugs that users encounter in the wild
- **Optimize performance** - Identify slow operations and bottlenecks
- **Plan development** - Prioritize new features based on usage patterns
- **Support compatibility** - Ensure Alchemy works well across different environments and runtimes

The data is processed securely and is not shared with third parties.