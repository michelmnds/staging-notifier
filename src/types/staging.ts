export const STAGING_ENVIRONMENTS = [
  "backend",
  "payer-web",
  "business-web",
] as const;

export type StagingEnvironment = (typeof STAGING_ENVIRONMENTS)[number];
export type StagingDestination = "pool" | StagingEnvironment;

export type StagingAssignments = Record<StagingEnvironment, string | null>;
export type StagingStartedAt = Record<StagingEnvironment, string | null>;

export const EMPTY_STAGING_ASSIGNMENTS: StagingAssignments = {
  backend: null,
  "payer-web": null,
  "business-web": null,
};

export const EMPTY_STAGING_STARTED_AT: StagingStartedAt = {
  backend: null,
  "payer-web": null,
  "business-web": null,
};
