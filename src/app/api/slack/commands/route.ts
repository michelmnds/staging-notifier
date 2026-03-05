import { NextResponse } from "next/server";
import users from "@/data/users.json";
import {
  formatStagingStatusText,
  syncStagingStatusMessage,
  verifySlackRequest,
} from "@/lib/slack";
import {
  getStagingOccupancy,
  moveUserToDestination,
} from "@/lib/staging-state";
import { STAGING_ENVIRONMENTS, type StagingEnvironment } from "@/types/staging";
import type { User } from "@/types/user";

export const runtime = "nodejs";

const usersList = users as User[];

const environmentAliasMap: Record<string, StagingEnvironment> = {
  backend: "backend",
  "payer-web": "payer-web",
  payerweb: "payer-web",
  "business-web": "business-web",
  businessweb: "business-web",
};

const environmentLabelByKey: Record<StagingEnvironment, string> = {
  backend: "backend",
  "payer-web": "payer-web",
  "business-web": "business-web",
};

type SlackUsersInfoResponse = {
  ok?: boolean;
  error?: string;
  user?: {
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      display_name_normalized?: string;
      real_name?: string;
      real_name_normalized?: string;
      email?: string;
    };
  };
};

function normalizeEnvInput(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function parseEnvironment(rawText: string | null) {
  if (!rawText) {
    return null;
  }

  const normalized = normalizeEnvInput(rawText);
  if (!normalized) {
    return null;
  }

  const byAlias = environmentAliasMap[normalized];
  if (byAlias) {
    return byAlias;
  }

  return environmentAliasMap[normalized.replaceAll("-", "")] || null;
}

function normalizeSlackName(value: string) {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ");
}

function normalizeSlackNameLoose(value: string) {
  return normalizeSlackName(value).replace(/[^a-z0-9]/g, "");
}

function normalizeSlackId(value: string) {
  return value.trim().toUpperCase();
}

function findUserBySlackNameCandidate(slackUserName: string | null) {
  if (!slackUserName || !slackUserName.trim()) {
    return null;
  }

  const normalizedSender = normalizeSlackName(slackUserName);
  const normalizedSenderLoose = normalizeSlackNameLoose(slackUserName);

  return (
    usersList.find((user) => {
      const candidates = [user["slack-name"], user.name, user.id].filter(
        (candidate): candidate is string => Boolean(candidate?.trim()),
      );

      return candidates.some((candidate) => {
        if (normalizeSlackName(candidate) === normalizedSender) {
          return true;
        }

        return normalizeSlackNameLoose(candidate) === normalizedSenderLoose;
      });
    }) || null
  );
}

function findUserBySlackId(slackUserId: string | null) {
  if (!slackUserId || !slackUserId.trim()) {
    return null;
  }

  const normalizedSenderId = normalizeSlackId(slackUserId);

  return (
    usersList.find((user) => {
      if (!user["slack-id"]) {
        return false;
      }

      return normalizeSlackId(user["slack-id"]) === normalizedSenderId;
    }) || null
  );
}

async function fetchSlackIdentityNameCandidates(slackUserId: string | null) {
  if (!slackUserId || !slackUserId.trim()) {
    return [];
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return [];
  }

  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const payload = (await response.json()) as SlackUsersInfoResponse;

    if (!response.ok || payload.ok !== true || !payload.user) {
      return [];
    }

    const profile = payload.user.profile;

    return Array.from(
      new Set(
        [
          payload.user.name,
          payload.user.real_name,
          profile?.display_name,
          profile?.display_name_normalized,
          profile?.real_name,
          profile?.real_name_normalized,
          profile?.email?.split("@")[0],
        ].filter((value): value is string => Boolean(value?.trim())),
      ),
    );
  } catch {
    return [];
  }
}

async function resolveSenderUser(params: URLSearchParams) {
  const slackUserId = params.get("user_id");
  const slackUserName = params.get("user_name");

  const bySlackId = findUserBySlackId(slackUserId);
  if (bySlackId) {
    return { matchedUser: bySlackId, slackUserId, slackUserName };
  }

  const identityCandidates =
    await fetchSlackIdentityNameCandidates(slackUserId);
  const nameCandidates = Array.from(
    new Set(
      [slackUserName, ...identityCandidates].filter((value): value is string =>
        Boolean(value?.trim()),
      ),
    ),
  );

  for (const candidate of nameCandidates) {
    const byName = findUserBySlackNameCandidate(candidate);
    if (byName) {
      return { matchedUser: byName, slackUserId, slackUserName };
    }
  }

  return { matchedUser: null, slackUserId, slackUserName };
}

async function handleTakeCommand(params: URLSearchParams) {
  const destination = parseEnvironment(params.get("text"));

  if (!destination) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Usage: /staging-take {${STAGING_ENVIRONMENTS.join(" | ")}}`,
    });
  }

  const { matchedUser, slackUserName, slackUserId } =
    await resolveSenderUser(params);

  if (!matchedUser) {
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        `Could not match Slack user "${slackUserName || "unknown"}" (id: ${slackUserId || "unknown"}) to a dashboard user. ` +
        'Add "slack-id" (recommended) or "slack-name" in src/data/users.json.',
    });
  }

  const moveResult = await moveUserToDestination(matchedUser.id, destination);

  if (!moveResult.ok) {
    const occupyingUser = usersList.find(
      (candidate) => candidate.id === moveResult.occupiedByUserId,
    );

    return NextResponse.json({
      response_type: "ephemeral",
      text: `${environmentLabelByKey[destination]} is already occupied by ${occupyingUser?.name || "another user"}.`,
    });
  }

  const slackSync = await syncStagingStatusMessage();

  if (!slackSync.ok) {
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        `${matchedUser.name} was assigned to ${environmentLabelByKey[destination]}, ` +
        `but Slack status sync failed: ${slackSync.error || "unknown error"}.`,
    });
  }

  if (!moveResult.changed) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `${matchedUser.name} is already using ${environmentLabelByKey[destination]}.`,
    });
  }

  return NextResponse.json({
    response_type: "ephemeral",
    text: `${matchedUser.name} is now using ${environmentLabelByKey[destination]}.`,
  });
}

async function handleRemoveCommand(params: URLSearchParams) {
  const { matchedUser, slackUserName, slackUserId } =
    await resolveSenderUser(params);

  if (!matchedUser) {
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        `Could not match Slack user "${slackUserName || "unknown"}" (id: ${slackUserId || "unknown"}) to a dashboard user. ` +
        'Add "slack-id" (recommended) or "slack-name" in src/data/users.json.',
    });
  }

  const moveResult = await moveUserToDestination(matchedUser.id, "pool");
  const slackSync = await syncStagingStatusMessage();

  if (!moveResult.ok) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Could not remove ${matchedUser.name} from staging right now.`,
    });
  }

  if (!slackSync.ok) {
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        `${matchedUser.name} was removed from staging, ` +
        `but Slack status sync failed: ${slackSync.error || "unknown error"}.`,
    });
  }

  if (!moveResult.changed) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `${matchedUser.name} is not using any staging environment.`,
    });
  }

  return NextResponse.json({
    response_type: "ephemeral",
    text: `${matchedUser.name} was removed from staging.`,
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message:
      "This endpoint is for Slack slash commands and expects POST requests from Slack.",
  });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const params = new URLSearchParams(rawBody);

    if (params.get("ssl_check") === "1") {
      return new NextResponse("", { status: 200 });
    }

    const isValidRequest = verifySlackRequest({
      rawBody,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
    });

    if (!isValidRequest) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: "Invalid Slack signature. Check SLACK_SIGNING_SECRET and slash command URL.",
      });
    }

    const command = params.get("command");

    if (command === "/staging-take") {
      return handleTakeCommand(params);
    }

    if (command === "/staging-remove") {
      return handleRemoveCommand(params);
    }

    return NextResponse.json({
      response_type: "ephemeral",
      text: `Unsupported command: ${command || "unknown"}`,
    });
  } catch {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Slash command handler error. Check server logs and deployment URL.",
    });
  }
}
