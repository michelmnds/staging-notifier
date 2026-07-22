import { NextResponse } from "next/server";
import users from "@/data/users.json";
import { postStagingChangeNotifications } from "@/lib/slack";
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

const usersList = users as User[];

export async function POST(request: Request) {
  let payload: MovePayload;

  try {
    const parsedPayload = (await request.json()) as unknown;

    if (!parsedPayload || typeof parsedPayload !== "object") {
      throw new Error("Invalid payload shape.");
    }

    payload = parsedPayload as MovePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 },
    );
  }

  const userId = typeof payload.userId === "string" ? payload.userId.trim() : undefined;
  const destination = payload.destination;
  const sourceEnvironment =
    payload.sourceEnvironment === null ||
    (typeof payload.sourceEnvironment === "string" &&
      STAGING_ENVIRONMENTS.includes(payload.sourceEnvironment as StagingEnvironment))
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

    const notification = result.changed
      ? await postStagingChangeNotifications({
          userName: user.name,
          takenEnvironment: result.takenEnvironment,
          releasedEnvironments: result.releasedEnvironments,
        })
      : { ok: true };

    return NextResponse.json({
      ok: true,
      assignments: result.state.assignments,
      startedAt: result.state.startedAt,
      notificationError: notification.ok ? undefined : notification.error,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not update staging state." },
      { status: 500 },
    );
  }
}
