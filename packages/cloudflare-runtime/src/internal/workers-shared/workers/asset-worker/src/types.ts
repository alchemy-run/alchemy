export type Environment = "production" | "staging" | "fed-prod";

export interface ReadyAnalytics {
  logEvent: (e: ReadyAnalyticsEvent) => void;
}

export interface ReadyAnalyticsEvent {
  accountId?: number;
  indexId?: string;
  version?: number;
  doubles?: Array<number | undefined>;
  blobs?: Array<string | undefined>;
}
