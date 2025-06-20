# Project

Create and manage Prisma projects for application development and deployment.

## Example Usage

### Create a basic Prisma project

```ts
import { Project } from "alchemy/prisma";

const project = await Project("my-project", {
  name: "My App",
  description: "My application project"
});
```

### Create a project in a specific organization and region

```ts
import alchemy from "alchemy";
import { Project } from "alchemy/prisma";

const project = await Project("my-project", {
  name: "My App",
  organizationId: "org-123",
  region: "us-east-1",
  private: true,
  apiKey: alchemy.secret(process.env.PRISMA_API_KEY)
});
```

### Create a project with environment variables

```ts
const project = await Project("my-project", {
  name: "My App",
  environmentVariables: {
    "NODE_ENV": "production",
    "DATABASE_URL": "postgresql://..."
  }
});
```

## Input Properties

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| `name` | `string` | Name of the project | ✅ |
| `description` | `string` | Description of the project | ❌ |
| `organizationId` | `string` | Organization ID where the project will be created | ❌ |
| `region` | `string` | Region where the project will be deployed | ❌ |
| `private` | `boolean` | Whether the project is private | ❌ |
| `environmentVariables` | `Record<string, string>` | Environment variables for the project | ❌ |
| `apiKey` | `Secret` | Prisma API key (overrides PRISMA_API_KEY env var) | ❌ |
| `baseUrl` | `string` | Base URL for Prisma API (default: https://api.prisma.io) | ❌ |

## Output Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | The unique identifier of the project |
| `name` | `string` | Name of the project |
| `description` | `string` | Description of the project |
| `organizationId` | `string` | Organization ID |
| `region` | `string` | Deployment region |
| `private` | `boolean` | Whether the project is private |
| `createdAt` | `string` | Time at which the project was created |
| `updatedAt` | `string` | Time at which the project was last updated |
| `environments` | `PrismaEnvironment[]` | Project environments |

## Environment Object

Each environment in the `environments` array contains:

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Environment ID |
| `name` | `string` | Environment name |
| `type` | `string` | Environment type (development, staging, production) |
| `databaseUrl` | `Secret` | Database connection string (if available) |
| `createdAt` | `string` | Time at which the environment was created |
| `updatedAt` | `string` | Time at which the environment was last updated |

## Authentication

The PrismaProject resource requires authentication with the Prisma API. You can provide credentials in two ways:

### Environment Variable (Recommended)

Set the `PRISMA_API_KEY` environment variable:

```bash
export PRISMA_API_KEY="your-api-key-here"
```

### Explicit API Key

Pass the API key directly to the resource:

```ts
import alchemy from "alchemy";

const project = await Project("my-project", {
  name: "My App",
  apiKey: alchemy.secret(process.env.CUSTOM_PRISMA_KEY)
});
```

## Lifecycle Management

The PrismaProject resource supports full lifecycle management:

- **Create**: Creates a new Prisma project with the specified configuration
- **Update**: Updates project properties like name, description, and settings
- **Delete**: Removes the project and all associated resources

## Error Handling

The resource includes comprehensive error handling for common scenarios:

- Invalid API credentials
- Project name conflicts
- Network connectivity issues
- API rate limiting

All errors include detailed messages to help with troubleshooting.

## Related Resources

- **Environment**: Manage specific environments within a project
- **Schema**: Deploy and manage database schemas
- **Migration**: Handle database migrations

## Best Practices

1. **Use Environment Variables**: Store API keys in environment variables for security
2. **Descriptive Names**: Use clear, descriptive names for projects
3. **Environment Isolation**: Create separate projects for different stages (development, staging, production)
4. **Resource Cleanup**: Always use the `destroy` phase to clean up resources when no longer needed