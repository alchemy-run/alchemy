/**
 * Metadata returned by Cloudflare API for a worker script
 */
export interface WorkerScriptMetadata {
  /**
   * Worker ID
   */
  id: string;

  /**
   * Default environment information
   */
  default_environment?: WorkerDefaultEnvironment;

  /**
   * Worker creation timestamp
   */
  created_on: string;

  /**
   * Worker last modification timestamp
   */
  modified_on: string;

  /**
   * Worker usage model
   */
  usage_model: string;

  /**
   * Worker environments
   */
  environments?: WorkerEnvironment[];
}

/**
 * Worker script information
 */
export interface WorkerScriptInfo {
  /**
   * Script creation timestamp
   */
  created_on: string;

  /**
   * Script last modification timestamp
   */
  modified_on: string;

  /**
   * Script ID
   */
  id: string;

  /**
   * Script tag
   */
  tag: string;

  /**
   * Script tags
   */
  tags: string[];

  /**
   * Deployment ID
   */
  deployment_id: string;

  /**
   * Tail consumers
   */
  tail_consumers: any;

  /**
   * Whether logpush is enabled
   */
  logpush: boolean;

  /**
   * Observability settings
   */
  observability: {
    /**
     * Whether observability is enabled
     */
    enabled: boolean;

    /**
     * Head sampling rate
     */
    head_sampling_rate: number | null;
  };

  /**
   * Whether the script has assets
   */
  has_assets: boolean;

  /**
   * Whether the script has modules
   */
  has_modules: boolean;

  /**
   * Script etag
   */
  etag: string;

  /**
   * Script handlers
   */
  handlers: string[];

  /**
   * Where the script was last deployed from
   */
  last_deployed_from: string;

  /**
   * Script usage model
   */
  usage_model: string;
}

/**
 * Worker environment information
 */
export interface WorkerEnvironment {
  /**
   * Environment name
   */
  environment: string;

  /**
   * Environment creation timestamp
   */
  created_on: string;

  /**
   * Environment last modification timestamp
   */
  modified_on: string;
}

/**
 * Default environment with script information
 */
export interface WorkerDefaultEnvironment extends WorkerEnvironment {
  /**
   * Script information
   */
  script: WorkerScriptInfo;
}
