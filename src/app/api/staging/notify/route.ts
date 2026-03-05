import { NextResponse } from "next/server";
import { syncStagingStatusMessage } from "@/lib/slack";

export const runtime = "nodejs";

export async function POST(request: Request) {
  void request;
  const slack = await syncStagingStatusMessage();

  if (!slack.ok) {
    return NextResponse.json(slack, { status: 502 });
  }

  return NextResponse.json(slack);
}
