import { NextResponse } from "next/server";
import { getStagingState } from "@/lib/staging-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getStagingState();
    return NextResponse.json(
      { ok: true, ...state },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not read staging status." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
