import type * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { jsonEqual, parseOwnership, parsePathId } from "./ownership.ts";

export const KEYWORD_TARGETING_TYPE = "TARGETING_TYPE_KEYWORD";
export const CHANNEL_TARGETING_TYPE = "TARGETING_TYPE_CHANNEL";

export type AssignedTargetingDetails = {
  /** Keyword targeting (`TARGETING_TYPE_KEYWORD`). */
  keywordDetails?: {
    keyword?: string;
    negative?: boolean;
  };
  /** Channel targeting (`TARGETING_TYPE_CHANNEL`). */
  channelDetails?: {
    channelId?: string;
    negative?: boolean;
  };
  /** Digital content-label exclusion. */
  digitalContentLabelExclusionDetails?: {
    excludedContentRatingTier?: string;
  };
  /** Sensitive-category exclusion. */
  sensitiveCategoryExclusionDetails?: {
    excludedSensitiveCategory?: string;
  };
  /** Open Measurement inventory. */
  omidDetails?: {
    omid?: string;
  };
  /** URL targeting (`TARGETING_TYPE_URL`). */
  urlDetails?: {
    url?: string;
    negative?: boolean;
  };
  /** Gender targeting. */
  genderDetails?: {
    gender?: string;
  };
  /** Environment targeting. */
  environmentDetails?: {
    environment?: string;
  };
  /** Device-type targeting. */
  deviceTypeDetails?: {
    deviceType?: string;
  };
  /** Language targeting. */
  languageDetails?: {
    targetingOptionId?: string;
    negative?: boolean;
  };
  /** Viewability targeting. */
  viewabilityDetails?: {
    viewability?: string;
  };
  /** Age-range targeting. */
  ageRangeDetails?: {
    ageRange?: string;
  };
  /** Parental-status targeting. */
  parentalStatusDetails?: {
    parentalStatus?: string;
  };
  /** Household-income targeting. */
  householdIncomeDetails?: {
    householdIncome?: string;
  };
  /** App targeting. */
  appDetails?: {
    appId?: string;
    displayName?: string;
    negative?: boolean;
  };
  /** Inventory source group targeting. */
  inventorySourceGroupDetails?: {
    inventorySourceGroupId?: string;
  };
  /** Negative keyword list targeting. */
  negativeKeywordListDetails?: {
    negativeKeywordListId?: string;
  };
};

export const parseAssignedName = (name: string) => ({
  advertiserId: parsePathId(name, "advertisers"),
  lineItemId: parsePathId(name, "lineItems"),
  partnerId: parsePathId(name, "partners"),
  targetingType: parsePathId(name, "targetingTypes"),
  assignedTargetingOptionId: parsePathId(name, "assignedTargetingOptions"),
});

export const detailsFromOption = (
  option: dv.AssignedTargetingOption,
): AssignedTargetingDetails => {
  const details: AssignedTargetingDetails = {};
  if (option.keywordDetails) {
    details.keywordDetails = {
      keyword: parseOwnership(option.keywordDetails.keyword).text,
      negative: option.keywordDetails.negative,
    };
  }
  if (option.channelDetails) {
    details.channelDetails = {
      channelId: option.channelDetails.channelId,
      negative: option.channelDetails.negative,
    };
  }
  if (option.digitalContentLabelExclusionDetails) {
    details.digitalContentLabelExclusionDetails = {
      excludedContentRatingTier:
        option.digitalContentLabelExclusionDetails.excludedContentRatingTier,
    };
  }
  if (option.sensitiveCategoryExclusionDetails) {
    details.sensitiveCategoryExclusionDetails = {
      excludedSensitiveCategory:
        option.sensitiveCategoryExclusionDetails.excludedSensitiveCategory,
    };
  }
  if (option.omidDetails) {
    details.omidDetails = { omid: option.omidDetails.omid };
  }
  if (option.urlDetails) {
    details.urlDetails = {
      url: option.urlDetails.url,
      negative: option.urlDetails.negative,
    };
  }
  if (option.genderDetails) {
    details.genderDetails = { gender: option.genderDetails.gender };
  }
  if (option.environmentDetails) {
    details.environmentDetails = {
      environment: option.environmentDetails.environment,
    };
  }
  if (option.deviceTypeDetails) {
    details.deviceTypeDetails = {
      deviceType: option.deviceTypeDetails.deviceType,
    };
  }
  if (option.languageDetails) {
    details.languageDetails = {
      targetingOptionId: option.languageDetails.targetingOptionId,
      negative: option.languageDetails.negative,
    };
  }
  if (option.viewabilityDetails) {
    details.viewabilityDetails = {
      viewability: option.viewabilityDetails.viewability,
    };
  }
  if (option.ageRangeDetails) {
    details.ageRangeDetails = { ageRange: option.ageRangeDetails.ageRange };
  }
  if (option.parentalStatusDetails) {
    details.parentalStatusDetails = {
      parentalStatus: option.parentalStatusDetails.parentalStatus,
    };
  }
  if (option.householdIncomeDetails) {
    details.householdIncomeDetails = {
      householdIncome: option.householdIncomeDetails.householdIncome,
    };
  }
  if (option.appDetails) {
    details.appDetails = {
      appId: option.appDetails.appId,
      displayName: option.appDetails.displayName,
      negative: option.appDetails.negative,
    };
  }
  if (option.inventorySourceGroupDetails) {
    details.inventorySourceGroupDetails = {
      inventorySourceGroupId:
        option.inventorySourceGroupDetails.inventorySourceGroupId,
    };
  }
  if (option.negativeKeywordListDetails) {
    details.negativeKeywordListDetails = {
      negativeKeywordListId:
        option.negativeKeywordListDetails.negativeKeywordListId,
    };
  }
  return details;
};

export const assignedBody = (
  details: AssignedTargetingDetails,
  stampedKeyword?: string,
): dv.AssignedTargetingOption => {
  const body: dv.AssignedTargetingOption = {};
  if (details.keywordDetails || stampedKeyword !== undefined) {
    body.keywordDetails = {
      keyword: stampedKeyword ?? details.keywordDetails?.keyword,
      negative: details.keywordDetails?.negative,
    };
  }
  if (details.channelDetails) body.channelDetails = details.channelDetails;
  if (details.digitalContentLabelExclusionDetails) {
    body.digitalContentLabelExclusionDetails =
      details.digitalContentLabelExclusionDetails;
  }
  if (details.sensitiveCategoryExclusionDetails) {
    body.sensitiveCategoryExclusionDetails =
      details.sensitiveCategoryExclusionDetails;
  }
  if (details.omidDetails) body.omidDetails = details.omidDetails;
  if (details.urlDetails) body.urlDetails = details.urlDetails;
  if (details.genderDetails) body.genderDetails = details.genderDetails;
  if (details.environmentDetails) {
    body.environmentDetails = details.environmentDetails;
  }
  if (details.deviceTypeDetails) {
    body.deviceTypeDetails = details.deviceTypeDetails;
  }
  if (details.languageDetails) body.languageDetails = details.languageDetails;
  if (details.viewabilityDetails) {
    body.viewabilityDetails = details.viewabilityDetails;
  }
  if (details.ageRangeDetails) body.ageRangeDetails = details.ageRangeDetails;
  if (details.parentalStatusDetails) {
    body.parentalStatusDetails = details.parentalStatusDetails;
  }
  if (details.householdIncomeDetails) {
    body.householdIncomeDetails = details.householdIncomeDetails;
  }
  if (details.appDetails) body.appDetails = details.appDetails;
  if (details.inventorySourceGroupDetails) {
    body.inventorySourceGroupDetails = details.inventorySourceGroupDetails;
  }
  if (details.negativeKeywordListDetails) {
    body.negativeKeywordListDetails = details.negativeKeywordListDetails;
  }
  return body;
};

export const detailsOf = (
  props: AssignedTargetingDetails,
): AssignedTargetingDetails => detailsFromOption(assignedBody(props));

export const detailsEqual = (
  left: AssignedTargetingDetails,
  right: AssignedTargetingDetails,
) => jsonEqual(detailsOf(left), detailsOf(right));

export const ownershipTextOf = (option: dv.AssignedTargetingOption) =>
  option.keywordDetails?.keyword;
