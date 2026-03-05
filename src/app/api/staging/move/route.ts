import { NextResponse } from "next/server";
import users from "@/data/users.json";
import { moveUserToDestination } from "@/lib/staging-state";
import {
  STAGING_ENVIRONMENTS,
  type StagingDestination,
  type StagingEnvironment,
} from "@/types/staging";
import type { User } from "@/types/user";

export const runtime = "nodejs";

type MovePayload = {
  userId?: string;
  destination?: StagingDestination;
  sourceEnvironment?: StagingEnvironment | null;
};

type NotificationPayload = {
  userName: string;
  previousEnvironment: StagingEnvironment | null;
  nextEnvironment: StagingEnvironment | null;
};

const usersList = users as User[];

export async function POST(request: Request) {
  let payload: MovePayload;

  try {
    payload = (await request.json()) as MovePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 },
    );
  }

  const userId = payload.userId?.trim();
  const destination = payload.destination;
  const sourceEnvironment =
    payload.sourceEnvironment === null ||
    STAGING_ENVIRONMENTS.includes(payload.sourceEnvironment as StagingEnvironment)
      ? payload.sourceEnvironment
      : undefined;
  const isValidDestination =
    destination === "pool" ||
    STAGING_ENVIRONMENTS.includes(destination as StagingEnvironment);

  if (!userId || !isValidDestination || sourceEnvironment === undefined) {
    return NextResponse.json(
      {
        ok: false,
        error: "userId, destination and a valid sourceEnvironment are required.",
      },
      { status: 400 },
    );
  }

  const user = usersList.find((candidate) => candidate.id === userId);
  if (!user) {
    return NextResponse.json({ ok: false, error: "User not found." }, { status: 404 });
  }

  try {
    const result = await moveUserToDestination(
      userId,
      destination as StagingDestination,
      sourceEnvironment,
    );

    if (!result.ok) {
      const occupyingUser = usersList.find(
        (candidate) => candidate.id === result.occupiedByUserId,
      );

      return NextResponse.json(
        {
          ok: false,
          error: `${result.destination} is already occupied.`,
          occupiedByName: occupyingUser?.name,
          assignments: result.state.assignments,
          startedAt: result.state.startedAt,
        },
        { status: 409 },
      );
    }

    const notification: NotificationPayload | null = result.changed
      ? {
          userName: user.name,
          previousEnvironment: result.previousEnvironment,
          nextEnvironment: result.nextEnvironment,
        }
      : null;

    return NextResponse.json({
      ok: true,
      assignments: result.state.assignments,
      startedAt: result.state.startedAt,
      notification,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not update staging state." },
      { status: 500 },
    );
  }
}
