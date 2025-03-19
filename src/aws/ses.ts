import {
  CreateConfigurationSetCommand,
  CreateEmailIdentityCommand,
  DeleteConfigurationSetCommand,
  DeleteEmailIdentityCommand,
  type DeliveryOptions,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  PutConfigurationSetDeliveryOptionsCommand,
  PutConfigurationSetReputationOptionsCommand,
  PutConfigurationSetSendingOptionsCommand,
  PutConfigurationSetSuppressionOptionsCommand,
  PutConfigurationSetTrackingOptionsCommand,
  PutEmailIdentityDkimAttributesCommand,
  type ReputationOptions,
  SESv2Client,
  type SendingOptions,
  type SuppressionOptions,
  type TrackingOptions,
} from "@aws-sdk/client-sesv2";
import { ignore } from "../error";
import { type Context, Resource } from "../resource";

/**
 * Properties for configuring AWS SES resources
 */
export interface SESProps {
  /**
   * Name of the configuration set
   */
  configurationSetName?: string;

  /**
   * Email identity to verify (email address or domain)
   */
  emailIdentity?: string;

  /**
   * Whether to enable DKIM signing for the email identity
   */
  enableDkim?: boolean;

  /**
   * Sending options for the configuration set
   */
  sendingOptions?: SendingOptions;

  /**
   * Reputation options for the configuration set
   */
  reputationOptions?: ReputationOptions;

  /**
   * Tracking options for the configuration set
   */
  trackingOptions?: TrackingOptions;

  /**
   * Suppression options for the configuration set
   */
  suppressionOptions?: SuppressionOptions;

  /**
   * Delivery options for the configuration set
   */
  deliveryOptions?: DeliveryOptions;

  /**
   * Tags to apply to the SES resources
   */
  tags?: Record<string, string>;
}

/**
 * Output returned after SES resource creation/update
 */
export interface SESOutput extends SESProps {
  /**
   * Resource ID
   */
  id: string;

  /**
   * ARN of the configuration set if created
   */
  configurationSetArn?: string;

  /**
   * Email identity verification status if an identity was created
   */
  emailIdentityVerificationStatus?: string;

  /**
   * DKIM verification status if DKIM was enabled
   */
  dkimVerificationStatus?: string;

  /**
   * Email identity ARN if an identity was created
   */
  emailIdentityArn?: string;
}

/**
 * AWS SES resource for creating and configuring Simple Email Service
 */
export class SES extends Resource(
  "aws::SES",
  async (ctx: Context<SESOutput>, props: SESProps) => {
    // Create SES client
    const client = new SESv2Client({});

    // Resource ID is either based on the configuration set name or email identity
    const id =
      props.configurationSetName || props.emailIdentity || ctx.resourceID;

    // Handle deletion
    if (ctx.event === "delete") {
      const output = ctx.output;

      // Delete configuration set if it exists
      if (output?.configurationSetName) {
        await ignore(NotFoundException.name, () =>
          client.send(
            new DeleteConfigurationSetCommand({
              ConfigurationSetName: output.configurationSetName,
            }),
          ),
        );
      }

      // Delete email identity if it exists
      if (output?.emailIdentity) {
        await ignore(NotFoundException.name, () =>
          client.send(
            new DeleteEmailIdentityCommand({
              EmailIdentity: output.emailIdentity,
            }),
          ),
        );
      }

      // Return empty output for delete
      return;
    }

    // Created resources
    let configurationSetArn: string | undefined;
    let emailIdentityArn: string | undefined;
    let emailIdentityVerificationStatus: string | undefined;
    let dkimVerificationStatus: string | undefined;

    // Create or update configuration set if specified
    if (props.configurationSetName) {
      try {
        // Check if configuration set exists
        let configSetExists = false;
        try {
          await client.send(
            new GetConfigurationSetCommand({
              ConfigurationSetName: props.configurationSetName,
            }),
          );
          configSetExists = true;
        } catch (error) {
          if (error instanceof NotFoundException) {
            configSetExists = false;
          } else {
            throw error;
          }
        }

        if (configSetExists) {
          // Update existing configuration set using appropriate update commands
          if (props.sendingOptions) {
            await client.send(
              new PutConfigurationSetSendingOptionsCommand({
                ConfigurationSetName: props.configurationSetName,
                SendingEnabled: props.sendingOptions.SendingEnabled,
              }),
            );
          }

          if (props.reputationOptions) {
            await client.send(
              new PutConfigurationSetReputationOptionsCommand({
                ConfigurationSetName: props.configurationSetName,
                ReputationMetricsEnabled:
                  props.reputationOptions.ReputationMetricsEnabled,
              }),
            );
          }

          if (props.trackingOptions) {
            await client.send(
              new PutConfigurationSetTrackingOptionsCommand({
                ConfigurationSetName: props.configurationSetName,
                CustomRedirectDomain:
                  props.trackingOptions.CustomRedirectDomain,
              }),
            );
          }

          if (props.suppressionOptions) {
            await client.send(
              new PutConfigurationSetSuppressionOptionsCommand({
                ConfigurationSetName: props.configurationSetName,
                SuppressedReasons: props.suppressionOptions.SuppressedReasons,
              }),
            );
          }

          if (props.deliveryOptions) {
            await client.send(
              new PutConfigurationSetDeliveryOptionsCommand({
                ConfigurationSetName: props.configurationSetName,
                TlsPolicy: props.deliveryOptions.TlsPolicy,
                SendingPoolName: props.deliveryOptions.SendingPoolName,
              }),
            );
          }

          // In SESv2, the ARN isn't directly returned in the response
          configurationSetArn = `arn:aws:ses:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:configuration-set/${props.configurationSetName}`;
        } else {
          // Create new configuration set
          await client.send(
            new CreateConfigurationSetCommand({
              ConfigurationSetName: props.configurationSetName,
              SendingOptions: props.sendingOptions,
              ReputationOptions: props.reputationOptions,
              TrackingOptions: props.trackingOptions,
              SuppressionOptions: props.suppressionOptions,
              DeliveryOptions: props.deliveryOptions,
              Tags: Object.entries(props.tags || {}).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            }),
          );

          // In SESv2, the ARN isn't directly returned in the response
          configurationSetArn = `arn:aws:ses:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:configuration-set/${props.configurationSetName}`;
        }
      } catch (error: any) {
        throw error;
      }
    }

    // Create or verify email identity if specified
    if (props.emailIdentity) {
      try {
        // Check if identity exists
        let getIdentityResult;
        try {
          getIdentityResult = await client.send(
            new GetEmailIdentityCommand({
              EmailIdentity: props.emailIdentity,
            }),
          );
        } catch (error) {
          if (error instanceof NotFoundException) {
            getIdentityResult = null;
          } else {
            throw error;
          }
        }

        if (!getIdentityResult) {
          // Create new email identity
          const createIdentityResult = await client.send(
            new CreateEmailIdentityCommand({
              EmailIdentity: props.emailIdentity,
              Tags: Object.entries(props.tags || {}).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            }),
          );

          // If it's an email address, we don't need to explicitly verify in v2
          // The verification email is automatically sent by SES in v2

          // Store the identity information
          emailIdentityArn = `arn:aws:ses:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:identity/${props.emailIdentity}`;
          emailIdentityVerificationStatus =
            createIdentityResult.VerifiedForSendingStatus
              ? "VERIFIED"
              : "PENDING";
        } else {
          // Store the identity information
          emailIdentityArn = `arn:aws:ses:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:identity/${props.emailIdentity}`;
          emailIdentityVerificationStatus =
            getIdentityResult.VerifiedForSendingStatus ? "VERIFIED" : "PENDING";

          // Update DKIM settings if requested
          if (props.enableDkim !== undefined) {
            if (props.enableDkim) {
              await client.send(
                new PutEmailIdentityDkimAttributesCommand({
                  EmailIdentity: props.emailIdentity,
                  SigningEnabled: true,
                }),
              );

              // We can check the current status of DKIM
              dkimVerificationStatus = "PENDING"; // Default to pending

              // Get the updated identity to check DKIM status
              const updatedIdentity = await client.send(
                new GetEmailIdentityCommand({
                  EmailIdentity: props.emailIdentity,
                }),
              );

              if (updatedIdentity.DkimAttributes?.Status) {
                dkimVerificationStatus = updatedIdentity.DkimAttributes.Status;
              }
            }
          }
        }
      } catch (error) {
        console.error(
          `Error configuring email identity ${props.emailIdentity}:`,
          error,
        );
        throw error;
      }
    }

    // Return the resource output
    return {
      ...props,
      id,
      configurationSetArn,
      emailIdentityArn,
      emailIdentityVerificationStatus,
      dkimVerificationStatus,
    };
  },
) {}
