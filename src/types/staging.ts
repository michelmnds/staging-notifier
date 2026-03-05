export const STAGING_ENVIRONMENTS = [
  "backend",
  "payer-app",
  "payer-web",
  "business-web",
] as const;

export type StagingEnvironment = (typeof STAGING_ENVIRONMENTS)[number];
export type StagingDestination = "pool" | StagingEnvironment;

export type StagingAssignments = Record<StagingEnvironment, string | null>;

export const EMPTY_STAGING_ASSIGNMENTS: StagingAssignments = {
  backend: null,
  "payer-app": null,
  "payer-web": null,
  "business-web": null,
};
