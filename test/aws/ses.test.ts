import {
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { SES } from "../../src/aws/ses";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

describe("SES Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-ses`;

  test("create, update, and delete configuration set", async () => {
    // Create a test configuration set
    const configurationSetName = `${testId}-config-set`;
    const ses = new SES(testId, {
      configurationSetName,
      sendingOptions: {
        SendingEnabled: true,
      },
      tags: {
        Environment: "test",
        Project: "alchemy",
      },
    });

    try {
      // Apply to create the configuration set
      const output = await apply(ses);
      expect(output.id).toContain(testId);
      expect(output.configurationSetName).toBe(configurationSetName);
      expect(output.configurationSetArn).toBeTruthy();

      // Verify configuration set was created by querying the API directly
      const client = new SESv2Client({});
      const getResponse = await client.send(
        new GetConfigurationSetCommand({
          ConfigurationSetName: configurationSetName,
        }),
      );

      // In SESv2, check the sending options specifically
      expect(getResponse).toBeTruthy();
      expect(getResponse.SendingOptions?.SendingEnabled).toBe(true);

      // Update the configuration set
      const updatedSes = new SES(testId, {
        configurationSetName,
        sendingOptions: {
          SendingEnabled: false,
        },
        tags: {
          Environment: "test",
          Project: "alchemy",
          Updated: "true",
        },
      });

      const updateOutput = await apply(updatedSes);
      expect(updateOutput.id).toContain(testId);

      // Check if ARNs match when they exist
      if (updateOutput.configurationSetArn && output.configurationSetArn) {
        expect(updateOutput.configurationSetArn).toBe(
          output.configurationSetArn,
        );
      }

      // Verify configuration set was updated
      const getUpdatedResponse = await client.send(
        new GetConfigurationSetCommand({
          ConfigurationSetName: configurationSetName,
        }),
      );

      // In SESv2, check the sending options specifically
      expect(getUpdatedResponse.SendingOptions?.SendingEnabled).toBe(false);
    } finally {
      // Clean up
      await destroy(ses);

      // Verify configuration set was deleted
      const client = new SESv2Client({});
      try {
        await client.send(
          new GetConfigurationSetCommand({
            ConfigurationSetName: configurationSetName,
          }),
        );
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof NotFoundException).toBe(true);
      }
    }
  });

  test("create, update, and delete email identity", async () => {
    // Using a domain for testing is better than an email address
    // since email addresses require actual verification
    const testDomain = `${testId.toLowerCase()}.example.com`;
    const ses = new SES(`${testId}-domain`, {
      emailIdentity: testDomain,
      enableDkim: true,
      tags: {
        Environment: "test",
        Project: "alchemy",
      },
    });

    try {
      // Apply to create the email identity
      const output = await apply(ses);
      expect(output.id).toContain(testId);
      expect(output.emailIdentity).toBe(testDomain);
      expect(output.emailIdentityArn).toBeTruthy();

      // Verification status may be PENDING or VERIFIED depending on the domain
      expect(output.emailIdentityVerificationStatus).toBeDefined();

      // DKIM status may not be immediately available
      if (output.dkimVerificationStatus) {
        expect([
          "PENDING",
          "SUCCESS",
          "FAILED",
          "TEMPORARY_FAILURE",
          "NOT_STARTED",
        ]).toContain(output.dkimVerificationStatus);
      }

      // Verify email identity was created by querying the API directly
      const client = new SESv2Client({});
      const getResponse = await client.send(
        new GetEmailIdentityCommand({
          EmailIdentity: testDomain,
        }),
      );

      // Check that the identity exists (it should have DkimAttributes)
      expect(getResponse).toBeTruthy();
      expect(getResponse.DkimAttributes).toBeDefined();
    } finally {
      // Clean up
      await destroy(ses);

      // Verify email identity was deleted
      const client = new SESv2Client({});
      try {
        await client.send(
          new GetEmailIdentityCommand({
            EmailIdentity: testDomain,
          }),
        );
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof NotFoundException).toBe(true);
      }
    }
  });
});
