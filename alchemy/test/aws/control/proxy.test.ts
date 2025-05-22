import { describe, expect } from "bun:test";
import { alchemy } from "../../../src/alchemy.js";
import AWS from "../../../src/aws/control";
import { destroy } from "../../../src/destroy.js";
import { BRANCH_PREFIX } from "../../util.js";
// must import this or else alchemy.test won't exist
import "../../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("AWS Cloud Control Proxy", () => {
	const testId = `${BRANCH_PREFIX}-test-bucket`;

	test("create, update, and delete S3 bucket using proxy interface", async (scope) => {
		let bucket: any;
		try {
			// Create a test S3 bucket using the proxy interface
			bucket = await AWS.S3.Bucket(testId, {
				BucketName: testId,
				VersioningConfiguration: {
					Status: "Enabled",
				},
			});

			expect(bucket.BucketName).toEqual(testId);
			expect(bucket.VersioningConfiguration.Status).toEqual("Enabled");

			// Update the bucket configuration
			bucket = await AWS.S3.Bucket(testId, {
				BucketName: testId,
				VersioningConfiguration: {
					Status: "Suspended",
				},
			});

			expect(bucket.BucketName).toEqual(testId);
			expect(bucket.VersioningConfiguration.Status).toEqual("Suspended");
		} finally {
			// Clean up
			await destroy(scope);
		}
	});

	test("adopt existing resource with different ID using proxy", async (scope) => {
		const bucketName = `${testId}-adopt-proxy-test`;
		const firstId = `${testId}-proxy-first`;
		const secondId = `${testId}-proxy-second`;

		let firstBucket: any;
		let secondBucket: any;

		try {
			// Create first bucket using proxy interface
			firstBucket = await AWS.S3.Bucket(firstId, {
				BucketName: bucketName,
				VersioningConfiguration: {
					Status: "Enabled",
				},
			});

			expect(firstBucket.BucketName).toEqual(bucketName);
			expect(firstBucket.VersioningConfiguration.Status).toEqual("Enabled");

			// Try to create second bucket with same name but different ID - should adopt the existing one
			secondBucket = await AWS.S3.Bucket(secondId, {
				BucketName: bucketName, // Same bucket name
				VersioningConfiguration: {
					Status: "Suspended", // Different config
				},
				adopt: true, // Enable adoption
			});

			expect(secondBucket.BucketName).toEqual(bucketName);
			expect(secondBucket.VersioningConfiguration.Status).toEqual("Suspended");

			// Both should reference the same underlying AWS resource
			// Note: We can't directly compare IDs here since the proxy interface
			// doesn't expose the internal resource ID, but we can verify the
			// bucket name and that the configuration was updated
		} catch (err) {
			console.log(err);
			throw err;
		} finally {
			// Clean up
			await destroy(scope);
		}
	});

	test("proxy returns same handler for same resource type", async (scope) => {
		const handler1 = AWS.S3.Bucket;
		const handler2 = AWS.S3.Bucket;
		expect(handler1).toBe(handler2);
	});

	test("proxy constructs correct type names", async (scope) => {
		const testRoleId = `${BRANCH_PREFIX}-test-role`;
		try {
			const role = await AWS.IAM.Role(testRoleId, {
				RoleName: testRoleId,
				AssumeRolePolicyDocument: {
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
			});

			expect(role.RoleName).toEqual(testRoleId);
		} finally {
			await destroy(scope);
		}
	});

	test("handles invalid bucket configuration", async (scope) => {
		try {
			// Attempt to create a bucket with invalid configuration
			await AWS.S3.Bucket("bucket", {
				BucketName: "invalid/bucket/name", // Invalid character in bucket name
				VersioningConfiguration: {
					Status: "InvalidStatus", // Invalid versioning status
				},
			});
			throw new Error("Should have thrown an error");
		} catch (error: any) {
			expect(error.message).toContain("Bad Request");
		} finally {
			await destroy(scope);
		}
	});

	test("create and delete DynamoDB table", async (scope) => {
		const tableId = `${BRANCH_PREFIX}-test-table`;
		try {
			const table = await AWS.DynamoDB.Table(tableId, {
				TableName: tableId,
				AttributeDefinitions: [
					{
						AttributeName: "id",
						AttributeType: "S",
					} as const,
				],
				KeySchema: [
					{
						AttributeName: "id",
						KeyType: "HASH",
					} as const,
				],
				ProvisionedThroughput: {
					ReadCapacityUnits: 1,
					WriteCapacityUnits: 1,
				},
			});

			expect(table.TableName).toEqual(tableId);
			expect(table.KeySchema).toHaveLength(1);
			expect(table.KeySchema[0].AttributeName).toEqual("id");
		} finally {
			await destroy(scope);
		}
	});

	test("create and delete Lambda function", async (scope) => {
		const functionId = `${BRANCH_PREFIX}-test-function`;
		const roleId = `${BRANCH_PREFIX}-test-function-role`;

		try {
			// Create execution role for Lambda
			const role = await AWS.IAM.Role(roleId, {
				RoleName: roleId,
				AssumeRolePolicyDocument: {
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
				ManagedPolicyArns: [
					"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
				],
			});

			// Create Lambda function after ensuring role exists
			const func = await AWS.Lambda.Function(functionId, {
				FunctionName: functionId,
				Role: role.Arn!,
				Code: {
					ZipFile: "exports.handler = async () => ({ statusCode: 200 });",
				},
				Handler: "index.handler",
				Runtime: "nodejs20.x",
			});

			expect(func.FunctionName).toEqual(functionId);
			expect(func.Runtime).toEqual("nodejs20.x");
		} finally {
			await destroy(scope);
		}
	});
});
