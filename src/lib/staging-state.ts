import { promises as fs } from "node:fs";
import path from "node:path";
import users from "@/data/users.json";
import {
  EMPTY_STAGING_ASSIGNMENTS,
  EMPTY_STAGING_STARTED_AT,
  STAGING_ENVIRONMENTS,
  type StagingAssignments,
  type StagingDestination,
  type StagingEnvironment,
  type StagingStartedAt,
} from "@/types/staging";
import type { User } from "@/types/user";

export type StagingState = {
  assignments: StagingAssignments;
  startedAt: StagingStartedAt;
  updatedAt: string;
  slackStatusMessageTs: string | null;
};

type LegacyStagingState = {
  usingStagingUserIds?: string[];
  startedAt?: unknown;
  updatedAt?: string;
  slackStatusMessageTs?: string;
};

export type MoveUserResult =
  | {
      ok: true;
      changed: boolean;
      state: StagingState;
      previousEnvironment: StagingEnvironment | null;
      nextEnvironment: StagingEnvironment | null;
    }
  | {
      ok: false;
      error: "destination_occupied";
      state: StagingState;
      occupiedByUserId: string;
      destination: StagingEnvironment;
    };

const usersList = users as User[];
const validUserIds = new Set(usersList.map((user) => user.id));
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const stateFilePath = isVercelRuntime
  ? path.join("/tmp", "staging-state.json")
  : path.join(process.cwd(), "src", "data", "staging-state.json");

const defaultState: StagingState = {
  assignments: { ...EMPTY_STAGING_ASSIGNMENTS },
  startedAt: { ...EMPTY_STAGING_STARTED_AT },
  updatedAt: "",
  slackStatusMessageTs: null,
};

let inMemoryState: StagingState | null = null;
let hasAttemptedSlackRecovery = false;
let isRecoveringFromSlack = false;

function createEmptyAssignments(): StagingAssignments {
  return { ...EMPTY_STAGING_ASSIGNMENTS };
}

function createEmptyStartedAt(): StagingStartedAt {
  return { ...EMPTY_STAGING_STARTED_AT };
}

function sanitizeUserIds(ids: string[]) {
  return Array.from(new Set(ids)).filter((id) => validUserIds.has(id));
}

function sanitizeAssignments(input: unknown): StagingAssignments {
  const nextAssignments = createEmptyAssignments();

  if (!input || typeof input !== "object") {
    return nextAssignments;
  }

  for (const environment of STAGING_ENVIRONMENTS) {
    const candidate = (input as Partial<Record<StagingEnvironment, unknown>>)[environment];
    nextAssignments[environment] =
      typeof candidate === "string" && validUserIds.has(candidate) ? candidate : null;
  }

  return nextAssignments;
}

function sanitizeStartedAt(
  input: unknown,
  assignments: StagingAssignments,
): StagingStartedAt {
  const nextStartedAt = createEmptyStartedAt();

  if (!input || typeof input !== "object") {
    return nextStartedAt;
  }

  for (const environment of STAGING_ENVIRONMENTS) {
    const candidate = (input as Partial<Record<StagingEnvironment, unknown>>)[environment];

    if (!assignments[environment]) {
      nextStartedAt[environment] = null;
      continue;
    }

    if (typeof candidate !== "string") {
      nextStartedAt[environment] = null;
      continue;
    }

    nextStartedAt[environment] =
      Number.isNaN(Date.parse(candidate)) ? null : candidate;
  }

  return nextStartedAt;
}

function buildStartedAtFromUpdatedAt(
  assignments: StagingAssignments,
  updatedAt: string,
): StagingStartedAt {
  const nextStartedAt = createEmptyStartedAt();
  const hasValidUpdatedAt = Boolean(updatedAt) && !Number.isNaN(Date.parse(updatedAt));

  for (const environment of STAGING_ENVIRONMENTS) {
    if (assignments[environment] && hasValidUpdatedAt) {
      nextStartedAt[environment] = updatedAt;
    }
  }

  return nextStartedAt;
}

function migrateLegacyState(parsed: LegacyStagingState): StagingAssignments {
  const legacyUserIds = sanitizeUserIds(
    Array.isArray(parsed.usingStagingUserIds) ? parsed.usingStagingUserIds : [],
  );

  const nextAssignments = createEmptyAssignments();

  for (const [index, environment] of STAGING_ENVIRONMENTS.entries()) {
    nextAssignments[environment] = legacyUserIds[index] || null;
  }

  return nextAssignments;
}

function hasAssignedUsers(assignments: StagingAssignments) {
  return STAGING_ENVIRONMENTS.some((environment) => Boolean(assignments[environment]));
}

function shouldAttemptSlackRecovery(state: StagingState) {
  return (
    isVercelRuntime &&
    !hasAttemptedSlackRecovery &&
    !isRecoveringFromSlack &&
    !state.updatedAt &&
    !state.slackStatusMessageTs &&
    !hasAssignedUsers(state.assignments)
  );
}

async function recoverStateFromSlack() {
  if (!isVercelRuntime || hasAttemptedSlackRecovery || isRecoveringFromSlack) {
    return null;
  }

  hasAttemptedSlackRecovery = true;
  isRecoveringFromSlack = true;

  try {
    const slackModule = await import("@/lib/slack");
    const recovered = await slackModule.recoverStagingStateFromSlack();

    if (!recovered) {
      return null;
    }

    const recoveredAssignments = sanitizeAssignments(recovered.assignments);
    const recoveredState: StagingState = {
      assignments: recoveredAssignments,
      startedAt: sanitizeStartedAt(recovered.startedAt, recoveredAssignments),
      updatedAt:
        typeof recovered.updatedAt === "string" && recovered.updatedAt
          ? recovered.updatedAt
          : new Date().toISOString(),
      slackStatusMessageTs:
        typeof recovered.slackStatusMessageTs === "string"
          ? recovered.slackStatusMessageTs
          : null,
    };

    await writeState(recoveredState);
    return recoveredState;
  } catch {
    return null;
  } finally {
    isRecoveringFromSlack = false;
  }
}

async function writeState(state: StagingState) {
  inMemoryState = state;

  try {
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    if (!isVercelRuntime) {
      throw error;
    }
  }
}

export function findEnvironmentForUser(
  assignments: StagingAssignments,
  userId: string,
): StagingEnvironment | null {
  for (const environment of STAGING_ENVIRONMENTS) {
    if (assignments[environment] === userId) {
      return environment;
    }
  }

  return null;
}

export function getEnvironmentsForUser(
  assignments: StagingAssignments,
  userId: string,
): StagingEnvironment[] {
  const environments: StagingEnvironment[] = [];

  for (const environment of STAGING_ENVIRONMENTS) {
    if (assignments[environment] === userId) {
      environments.push(environment);
    }
  }

  return environments;
}

export function getAssignedUserIds(assignments: StagingAssignments): string[] {
  const ids = new Set<string>();

  for (const environment of STAGING_ENVIRONMENTS) {
    const userId = assignments[environment];
    if (userId) {
      ids.add(userId);
    }
  }

  return Array.from(ids);
}

export async function getStagingState(): Promise<StagingState> {
  try {
    const fileContent = await fs.readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(fileContent) as Partial<StagingState> & LegacyStagingState;

    const hasAssignments =
      parsed.assignments !== null &&
      typeof parsed.assignments === "object" &&
      !Array.isArray(parsed.assignments);
    const hasStartedAt =
      parsed.startedAt !== null &&
      typeof parsed.startedAt === "object" &&
      !Array.isArray(parsed.startedAt);

    const assignments = hasAssignments
      ? sanitizeAssignments(parsed.assignments)
      : migrateLegacyState(parsed);
    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaultState.updatedAt;
    const startedAt =
      hasStartedAt
        ? sanitizeStartedAt(parsed.startedAt, assignments)
        : buildStartedAtFromUpdatedAt(assignments, updatedAt);

    const state: StagingState = {
      assignments,
      startedAt,
      updatedAt,
      slackStatusMessageTs:
        typeof parsed.slackStatusMessageTs === "string"
          ? parsed.slackStatusMessageTs
          : defaultState.slackStatusMessageTs,
    };

    if (!hasAssignments || !hasStartedAt) {
      await writeState(state);
    }

    if (shouldAttemptSlackRecovery(state)) {
      const recoveredState = await recoverStateFromSlack();
      if (recoveredState) {
        return recoveredState;
      }
    }

    inMemoryState = state;

    return state;
  } catch {
    if (inMemoryState) {
      return inMemoryState;
    }

    const recoveredState = await recoverStateFromSlack();
    if (recoveredState) {
      return recoveredState;
    }

    await writeState(defaultState);
    return inMemoryState ?? defaultState;
  }
}

export async function moveUserToDestination(
  userId: string,
  destination: StagingDestination,
  sourceEnvironment: StagingEnvironment | null = null,
): Promise<MoveUserResult> {
  const currentState = await getStagingState();
  const assignments = { ...currentState.assignments };
  const startedAt = { ...currentState.startedAt };
  const previousEnvironments = getEnvironmentsForUser(assignments, userId);
  const previousEnvironment = previousEnvironments[0] || null;

  if (destination === "pool") {
    if (sourceEnvironment) {
      if (assignments[sourceEnvironment] !== userId) {
        return {
          ok: true,
          changed: false,
          state: currentState,
          previousEnvironment: null,
          nextEnvironment: null,
        };
      }

      assignments[sourceEnvironment] = null;
      startedAt[sourceEnvironment] = null;

      const nextState: StagingState = {
        assignments: sanitizeAssignments(assignments),
        startedAt: sanitizeStartedAt(startedAt, assignments),
        updatedAt: new Date().toISOString(),
        slackStatusMessageTs: currentState.slackStatusMessageTs,
      };

      await writeState(nextState);

      return {
        ok: true,
        changed: true,
        state: nextState,
        previousEnvironment: sourceEnvironment,
        nextEnvironment: null,
      };
    }

    if (previousEnvironments.length === 0) {
      return {
        ok: true,
        changed: false,
        state: currentState,
        previousEnvironment: null,
        nextEnvironment: null,
      };
    }

    for (const environment of previousEnvironments) {
      assignments[environment] = null;
      startedAt[environment] = null;
    }

    const nextState: StagingState = {
      assignments: sanitizeAssignments(assignments),
      startedAt: sanitizeStartedAt(startedAt, assignments),
      updatedAt: new Date().toISOString(),
      slackStatusMessageTs: currentState.slackStatusMessageTs,
    };

    await writeState(nextState);

    return {
      ok: true,
      changed: true,
      state: nextState,
      previousEnvironment,
      nextEnvironment: null,
    };
  }

  const occupant = assignments[destination];

  if (occupant && occupant !== userId) {
    return {
      ok: false,
      error: "destination_occupied",
      state: currentState,
      occupiedByUserId: occupant,
      destination,
    };
  }

  if (occupant === userId) {
    return {
      ok: true,
      changed: false,
      state: currentState,
      previousEnvironment,
      nextEnvironment: destination,
    };
  }

  assignments[destination] = userId;
  startedAt[destination] = new Date().toISOString();

  const nextState: StagingState = {
    assignments: sanitizeAssignments(assignments),
    startedAt: sanitizeStartedAt(startedAt, assignments),
    updatedAt: new Date().toISOString(),
    slackStatusMessageTs: currentState.slackStatusMessageTs,
  };

  await writeState(nextState);

  return {
    ok: true,
    changed: true,
    state: nextState,
    previousEnvironment,
    nextEnvironment: destination,
  };
}

export async function setSlackStatusMessageTs(ts: string | null) {
  const currentState = await getStagingState();

  if (currentState.slackStatusMessageTs === ts) {
    return currentState;
  }

  const nextState: StagingState = {
    ...currentState,
    slackStatusMessageTs: ts,
  };

  await writeState(nextState);
  return nextState;
}

export async function getStagingOccupancy() {
  const state = await getStagingState();
  const usersById = new Map(usersList.map((user) => [user.id, user]));

  return STAGING_ENVIRONMENTS.map((environment) => {
    const userId = state.assignments[environment];

    return {
      environment,
      user: userId ? usersById.get(userId) || null : null,
      startedAt: state.startedAt[environment],
    };
  });
}

export async function getUsersUsingStaging() {
  const state = await getStagingState();
  const usingIds = new Set(getAssignedUserIds(state.assignments));

  return usersList.filter((user) => usingIds.has(user.id));
}
