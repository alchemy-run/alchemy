import alchemy from "alchemy";
import { Function, Queue, Role, Table } from "alchemy/aws";
import { Bundle } from "alchemy/esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = await alchemy("aws-app");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [_queue, table, role] = await Promise.all([
  Queue("queue", {
    queueName: `${app.name}-${app.stage}-queue`,
    visibilityTimeout: 30,
    messageRetentionPeriod: 345600, // 4 days
  }),

  // Create DynamoDB table
  Table("table", {
    tableName: `${app.name}-${app.stage}-table`,
    partitionKey: {
      name: "id",
      type: "S",
    },
  }),

  // Create Lambda execution role with DynamoDB access
  Role("role", {
    roleName: `${app.name}-${app.stage}-lambda-role`,
    assumeRolePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: "lambda.amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
      ],
    },
  }),
]);

// Create Lambda function
const bundle = await Bundle("api-bundle", {
  entryPoint: path.join(__dirname, "src", "index.ts"),
  outdir: ".out",
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  sourcemap: true,
  // Don't bundle aws-sdk as it's provided by Lambda
  external: ["@aws-sdk/*"],
});

const _api = await Function("api", {
  functionName: `${app.name}-${app.stage}-api`,
  bundle,
  roleArn: role.arn,
  handler: "index.handler",
  environment: {
    TABLE_NAME: table.tableName,
  },
  url: {
    // Enable public access
    authType: "NONE",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
      allowHeaders: ["content-type"],
    },
  },
});

await app.finalize();
