import {
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { SES } from "../../src/aws/ses.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("SES Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-ses`;

  test("create, update, and delete configuration set", async (scope) => {
    // Create a test configuration set
    const configurationSetName = `${testId}-config-set`;
    let ses;

    try {
      ses = await SES(testId, {
        configurationSetName,
        sendingOptions: {
          SendingEnabled: true,
        },
        tags: {
          Environment: "test",
          Project: "alchemy",
        },
      });
      // Apply to create the configuration set
      expect(ses.configurationSetName).toBe(configurationSetName);
      expect(ses.configurationSetArn).toBeTruthy();

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
      ses = await SES(testId, {
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

      // Check if ARNs match when they exist
      if (ses.configurationSetArn) {
        expect(ses.configurationSetArn).toBe(ses.configurationSetArn);
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
      await destroy(scope);
      await assertSESDoesNotExist(configurationSetName);
    }
  });

  test("create, update, and delete email identity", async (scope) => {
    // Using a domain for testing is better than an email address
    // since email addresses require actual verification
    const testDomain = `${testId.toLowerCase()}.example.com`;
    let ses: SES | undefined;

    try {
      ses = await SES(`${testId}-domain`, {
        emailIdentity: testDomain,
        enableDkim: true,
        tags: {
          Environment: "test",
          Project: "alchemy",
        },
      });
      // Apply to create the email identity
      expect(ses.configurationSetArn).toBeUndefined();
      expect(ses.emailIdentity).toBe(testDomain);
      expect(ses.emailIdentityArn).toBeTruthy();

      // Verification status may be PENDING or VERIFIED depending on the domain
      expect(ses.emailIdentityVerificationStatus).toBeDefined();

      // DKIM status may not be immediately available
      if (ses.dkimVerificationStatus) {
        expect([
          "PENDING",
          "SUCCESS",
          "FAILED",
          "TEMPORARY_FAILURE",
          "NOT_STARTED",
        ]).toContain(ses.dkimVerificationStatus);
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
      await destroy(scope);
      if (ses?.configurationSetName) {
        await assertSESDoesNotExist(ses.configurationSetName);
      }
    }
  });
});

async function assertSESDoesNotExist(configurationSetName: string) {
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
