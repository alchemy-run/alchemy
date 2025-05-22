export interface AnalyticsEngineDatasetProps {
  /**
   * The name of the dataset to bind to -
   * becomes the table name to query via the api in the FROM clause
   */
  dataset: string;
}

/**
 * @example
 * // Create a binding for an Analytics Engine dataset
 * const dataset = new AnalyticsEngineDataset("ae-dataset", {
 *   dataset: "WEATHER",
 * });
 */
export class AnalyticsEngineDataset {
  public readonly type = "analytics_engine" as const;
  public readonly dataset: string;

  constructor(
    public readonly id: string,
    input: AnalyticsEngineDatasetProps,
  ) {
    this.dataset = input.dataset;
  }
}
