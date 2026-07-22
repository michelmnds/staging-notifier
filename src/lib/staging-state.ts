import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Redis } from "@upstash/redis";
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
};

type LegacyStagingState = {
  usingStagingUserIds?: string[];
  startedAt?: unknown;
  updatedAt?: string;
};

export type MoveUserResult =
  | {
      ok: true;
      changed: boolean;
      state: StagingState;
      previousEnvironment: StagingEnvironment | null;
      nextEnvironment: StagingEnvironment | null;
      releasedEnvironments: StagingEnvironment[];
      takenEnvironment: StagingEnvironment | null;
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
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
const redis =
  redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;
const redisStateKey =
  process.env.STAGING_STATE_REDIS_KEY?.trim() || "staging-notifier:state";
const redisLockKey = `${redisStateKey}:lock`;

const defaultState: StagingState = {
  assignments: { ...EMPTY_STAGING_ASSIGNMENTS },
  startedAt: { ...EMPTY_STAGING_STARTED_AT },
  updatedAt: "",
};

let inMemoryState: StagingState | null = null;

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

async function writeState(state: StagingState) {
  if (redis) {
    await redis.set(redisStateKey, state);
    inMemoryState = state;
    return;
  }

  try {
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    if (!isVercelRuntime) {
      throw error;
    }
  }

  inMemoryState = state;
}

function parseStoredState(input: unknown) {
  let parsedInput = input;

  if (typeof parsedInput === "string") {
    try {
      parsedInput = JSON.parse(parsedInput) as unknown;
    } catch {
      parsedInput = {};
    }
  }

  const parsed =
    parsedInput && typeof parsedInput === "object"
      ? (parsedInput as Partial<StagingState> & LegacyStagingState)
      : {};
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
  const startedAt = hasStartedAt
    ? sanitizeStartedAt(parsed.startedAt, assignments)
    : buildStartedAtFromUpdatedAt(assignments, updatedAt);

  return {
    state: { assignments, startedAt, updatedAt },
    needsMigration: !hasAssignments || !hasStartedAt,
  };
}

async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!redis) {
    return operation();
  }

  const lockToken = randomUUID();
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const acquired = await redis.set(redisLockKey, lockToken, {
      nx: true,
      px: 10_000,
    });

    if (acquired === "OK") {
      try {
        return await operation();
      } finally {
        try {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            [redisLockKey],
            [lockToken],
          );
        } catch {
          // The lock expires automatically if Redis is unavailable during cleanup.
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Could not acquire staging state lock.");
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

async function readStagingState(allowCacheFallback: boolean): Promise<StagingState> {
  if (redis) {
    try {
      const storedState = await redis.get<unknown>(redisStateKey);

      if (storedState === null) {
        const created = await redis.set(redisStateKey, defaultState, { nx: true });
        if (created === "OK") {
          inMemoryState = defaultState;
          return defaultState;
        }

        const initializedState = await redis.get<unknown>(redisStateKey);
        if (initializedState === null) {
          throw new Error("Staging state initialization failed.");
        }

        const { state } = parseStoredState(initializedState);
        inMemoryState = state;
        return state;
      }

      const { state } = parseStoredState(storedState);
      inMemoryState = state;

      return state;
    } catch (error) {
      if (allowCacheFallback && inMemoryState) {
        return inMemoryState;
      }

      throw error;
    }
  }

  try {
    const fileContent = await fs.readFile(stateFilePath, "utf8");
    const { state, needsMigration } = parseStoredState(fileContent);

    if (needsMigration) {
      await writeState(state);
    }

    inMemoryState = state;

    return state;
  } catch {
    if (inMemoryState) {
      return inMemoryState;
    }

    await writeState(defaultState);
    return inMemoryState ?? defaultState;
  }
}

export async function getStagingState(): Promise<StagingState> {
  return readStagingState(true);
}

async function moveUserWithoutLock(
  userId: string,
  destination: StagingDestination,
  sourceEnvironment: StagingEnvironment | null = null,
): Promise<MoveUserResult> {
  const currentState = await readStagingState(false);
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
          releasedEnvironments: [],
          takenEnvironment: null,
        };
      }

      assignments[sourceEnvironment] = null;
      startedAt[sourceEnvironment] = null;

      const nextState: StagingState = {
        assignments: sanitizeAssignments(assignments),
        startedAt: sanitizeStartedAt(startedAt, assignments),
        updatedAt: new Date().toISOString(),
      };

      await writeState(nextState);

      return {
        ok: true,
        changed: true,
        state: nextState,
        previousEnvironment: sourceEnvironment,
        nextEnvironment: null,
        releasedEnvironments: [sourceEnvironment],
        takenEnvironment: null,
      };
    }

    if (previousEnvironments.length === 0) {
      return {
        ok: true,
        changed: false,
        state: currentState,
        previousEnvironment: null,
        nextEnvironment: null,
        releasedEnvironments: [],
        takenEnvironment: null,
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
    };

    await writeState(nextState);

    return {
      ok: true,
      changed: true,
      state: nextState,
      previousEnvironment,
      nextEnvironment: null,
      releasedEnvironments: previousEnvironments,
      takenEnvironment: null,
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
      releasedEnvironments: [],
      takenEnvironment: null,
    };
  }

  assignments[destination] = userId;
  startedAt[destination] = new Date().toISOString();

  const nextState: StagingState = {
    assignments: sanitizeAssignments(assignments),
    startedAt: sanitizeStartedAt(startedAt, assignments),
    updatedAt: new Date().toISOString(),
  };

  await writeState(nextState);

  return {
    ok: true,
    changed: true,
    state: nextState,
    previousEnvironment,
    nextEnvironment: destination,
    releasedEnvironments: [],
    takenEnvironment: destination,
  };
}

export async function moveUserToDestination(
  userId: string,
  destination: StagingDestination,
  sourceEnvironment: StagingEnvironment | null = null,
) {
  return withStateLock(() =>
    moveUserWithoutLock(userId, destination, sourceEnvironment),
  );
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
