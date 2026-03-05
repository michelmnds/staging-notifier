import { createHmac, timingSafeEqual } from "node:crypto";
import users from "@/data/users.json";
import {
  getStagingOccupancy,
  getStagingState,
  setSlackStatusMessageTs,
} from "@/lib/staging-state";
import {
  EMPTY_STAGING_ASSIGNMENTS,
  EMPTY_STAGING_STARTED_AT,
  type StagingAssignments,
  type StagingEnvironment,
  type StagingStartedAt,
} from "@/types/staging";
import type { User } from "@/types/user";

type SlackResult = {
  ok: boolean;
  error?: string;
};

type VerifyRequestParams = {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
};

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
  text?: string;
  channels?: Array<{
    id: string;
    name: string;
  }>;
  messages?: Array<{
    ts?: string;
    text?: string;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

type OccupancyItem = {
  environment: StagingEnvironment;
  user: {
    name: string;
  } | null;
  startedAt: string | null;
};

export type RecoveredStagingState = {
  assignments: StagingAssignments;
  startedAt: StagingStartedAt;
  updatedAt: string;
  slackStatusMessageTs: string;
};

const usersList = users as User[];

const channelIdPattern = /^[CGD][A-Z0-9]{8,}$/;
const environmentLabelByKey: Record<StagingEnvironment, string> = {
  backend: "Backend",
  "payer-web": "Payer Web",
  "business-web": "Business Web",
};
const normalizedLabelToEnvironment = new Map(
  Object.entries(environmentLabelByKey).map(([environment, label]) => [
    normalizeText(label),
    environment as StagingEnvironment,
  ]),
);
const userIdByNormalizedName = new Map<string, string>();

for (const user of usersList) {
  const candidateNames = [user.name, user["slack-name"]].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  for (const candidateName of candidateNames) {
    const normalizedName = normalizeText(candidateName);
    if (!normalizedName || userIdByNormalizedName.has(normalizedName)) {
      continue;
    }

    userIdByNormalizedName.set(normalizedName, user.id);
  }
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slackTsToIso(ts: string) {
  const [secondsPart] = ts.split(".");
  const seconds = Number(secondsPart);

  if (Number.isNaN(seconds)) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

function createEmptyStartedAt(): StagingStartedAt {
  return { ...EMPTY_STAGING_STARTED_AT };
}

function formatSlackTimeToken(startedAt: string | null) {
  if (!startedAt) {
    return null;
  }

  const dateMs = Date.parse(startedAt);
  if (Number.isNaN(dateMs)) {
    return null;
  }

  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(new Date(dateMs))} (DE time)`;
}

function parseStartedAtToken(rawToken: string | undefined) {
  if (!rawToken) {
    return null;
  }

  const match = rawToken.match(/<!date\^(\d+)\^[^|>]+(?:\|[^>]+)?>/);
  if (!match) {
    return null;
  }

  const seconds = Number(match[1]);
  if (Number.isNaN(seconds)) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function looksLikeStagingStatusText(text: string) {
  const normalized = normalizeText(text);
  return (
    normalized.startsWith("environments") &&
    (normalized.includes("free to use") || normalized.includes("is using it"))
  );
}

function parseStateFromStatusText(text: string) {
  const assignments: StagingAssignments = { ...EMPTY_STAGING_ASSIGNMENTS };
  const startedAt: StagingStartedAt = createEmptyStartedAt();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      continue;
    }

    if (normalizeText(trimmedLine) === "environments") {
      continue;
    }

    const lineWithoutPrefix = trimmedLine.replace(/^[•✅❌]\s*/, "");
    const separatorIndex = lineWithoutPrefix.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const label = lineWithoutPrefix.slice(0, separatorIndex).trim();
    const statusText = lineWithoutPrefix.slice(separatorIndex + 1).trim();
    const environment = normalizedLabelToEnvironment.get(normalizeText(label));

    if (!environment) {
      continue;
    }

    if (normalizeText(statusText) === "free to use") {
      assignments[environment] = null;
      startedAt[environment] = null;
      continue;
    }

    const inUseMatch = statusText.match(
      /^(.+?)\s+is\s+using\s+it(?:\s+since\s+(.+))?$/i,
    );
    if (!inUseMatch) {
      continue;
    }

    const candidateName = normalizeText(inUseMatch[1]);
    assignments[environment] = candidateName
      ? userIdByNormalizedName.get(candidateName) || null
      : null;
    startedAt[environment] = parseStartedAtToken(inUseMatch[2]);
  }

  return { assignments, startedAt };
}

function normalizeChannelInput(rawChannel: string) {
  const trimmed = rawChannel.trim();
  const channelMentionMatch = trimmed.match(/^<#([CGD][A-Z0-9]+)\|[^>]+>$/);

  if (channelMentionMatch) {
    return channelMentionMatch[1];
  }

  return trimmed;
}

async function slackJsonRequest(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as SlackApiResponse;
  return { response, payload };
}

async function findChannelIdByName(token: string, channelName: string) {
  const normalizedName = channelName.replace(/^#/, "");

  const { payload } = await slackJsonRequest(token, "conversations.list", {
    limit: 1000,
    exclude_archived: true,
    types: "public_channel,private_channel",
  });

  if (payload.ok !== true || !Array.isArray(payload.channels)) {
    return {
      channelId: null,
      error: payload.error || "Could not list channels.",
    };
  }

  const match = payload.channels.find((channel) => channel.name === normalizedName);
  return { channelId: match?.id || null };
}

async function resolveChannelId(token: string, rawChannel: string) {
  const normalized = normalizeChannelInput(rawChannel);

  if (channelIdPattern.test(normalized)) {
    return { channelId: normalized };
  }

  const byNameResult = await findChannelIdByName(token, normalized);
  if (!byNameResult.channelId) {
    return {
      channelId: normalized,
      resolveError:
        byNameResult.error ||
        "Channel name could not be resolved. Prefer SLACK_CHANNEL as channel ID (C...).",
    };
  }

  return { channelId: byNameResult.channelId };
}

async function findLatestStagingStatusMessage(token: string, channel: string) {
  let cursor: string | undefined;
  let pages = 0;

  while (pages < 5) {
    pages += 1;

    const body: Record<string, unknown> = {
      channel,
      limit: 200,
    };

    if (cursor) {
      body.cursor = cursor;
    }

    const { response, payload } = await slackJsonRequest(
      token,
      "conversations.history",
      body,
    );

    if (!response.ok || payload.ok !== true || !Array.isArray(payload.messages)) {
      return null;
    }

    const match = payload.messages.find(
      (message) =>
        typeof message.ts === "string" &&
        typeof message.text === "string" &&
        looksLikeStagingStatusText(message.text),
    );

    if (match && match.ts && match.text) {
      return {
        ts: match.ts,
        text: match.text,
      };
    }

    const nextCursor = payload.response_metadata?.next_cursor?.trim();
    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return null;
}

export async function recoverStagingStateFromSlack(): Promise<RecoveredStagingState | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL || "#coders";

  if (!token) {
    return null;
  }

  try {
    const resolvedChannel = await resolveChannelId(token, channel);
    const message = await findLatestStagingStatusMessage(token, resolvedChannel.channelId);

    if (!message) {
      return null;
    }

    const parsedState = parseStateFromStatusText(message.text);

    return {
      assignments: parsedState.assignments,
      startedAt: parsedState.startedAt,
      updatedAt: slackTsToIso(message.ts),
      slackStatusMessageTs: message.ts,
    };
  } catch {
    return null;
  }
}

export function formatStagingStatusText(occupancy: OccupancyItem[]) {
  const lines = occupancy.map((item) => {
    const label = environmentLabelByKey[item.environment];

    if (!item.user) {
      return `✅ ${label}: Free to use`;
    }

    const startedAtText = formatSlackTimeToken(item.startedAt);

    return startedAtText
      ? `❌ ${label}: ${item.user.name} is using it since ${startedAtText}`
      : `❌ ${label}: ${item.user.name} is using it`;
  });

  return `*Environments:*\n${lines.join("\n")}`;
}

function formatSlackErrorMessage({
  payload,
  responseStatus,
  resolvedError,
  channel,
}: {
  payload: SlackApiResponse;
  responseStatus: number;
  resolvedError?: string;
  channel: string;
}) {
  if (payload.error === "not_in_channel") {
    return `Slack says not_in_channel. Confirm SLACK_CHANNEL is the channel ID (C...) and invite the app to that exact channel.${resolvedError ? ` ${resolvedError}` : ""}`;
  }

  if (payload.error === "channel_not_found") {
    return "Slack channel not found. Set SLACK_CHANNEL to the real channel ID (C...) from channel details.";
  }

  if (payload.error === "cant_update_message") {
    return "Slack could not update the status message. If the original message was deleted, a new one will be created.";
  }

  return payload.error || resolvedError || `Slack HTTP ${responseStatus} (channel ${channel})`;
}

async function slackWriteRequestWithJoin(
  token: string,
  endpoint: "chat.postMessage" | "chat.update",
  body: Record<string, unknown>,
) {
  const channel = String(body.channel || "");
  const firstTry = await slackJsonRequest(token, endpoint, body);

  if (firstTry.response.ok && firstTry.payload.ok === true) {
    return firstTry;
  }

  if (
    firstTry.payload.error === "not_in_channel" &&
    channelIdPattern.test(channel) &&
    channel.startsWith("C")
  ) {
    await slackJsonRequest(token, "conversations.join", {
      channel,
    });

    return slackJsonRequest(token, endpoint, body);
  }

  return firstTry;
}

export async function syncStagingStatusMessage(): Promise<SlackResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL || "#coders";

  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN is missing." };
  }

  try {
    const occupancy = await getStagingOccupancy();
    const text = formatStagingStatusText(occupancy);

    const resolvedChannel = await resolveChannelId(token, channel);
    const channelToUse = resolvedChannel.channelId;
    const currentState = await getStagingState();
    const fallbackTs = process.env.SLACK_STATUS_MESSAGE_TS?.trim() || null;
    let statusMessageTs = currentState.slackStatusMessageTs || fallbackTs;

    if (!statusMessageTs) {
      const recoveredState = await recoverStagingStateFromSlack();
      if (recoveredState?.slackStatusMessageTs) {
        statusMessageTs = recoveredState.slackStatusMessageTs;
        await setSlackStatusMessageTs(statusMessageTs);
      }
    }

    if (statusMessageTs) {
      const updateAttempt = await slackWriteRequestWithJoin(token, "chat.update", {
        channel: channelToUse,
        ts: statusMessageTs,
        text,
      });

      if (updateAttempt.response.ok && updateAttempt.payload.ok === true) {
        if (currentState.slackStatusMessageTs !== statusMessageTs) {
          await setSlackStatusMessageTs(statusMessageTs);
        }

        return { ok: true };
      }

      if (
        updateAttempt.payload.error !== "message_not_found" &&
        updateAttempt.payload.error !== "cant_update_message"
      ) {
        return {
          ok: false,
          error: formatSlackErrorMessage({
            payload: updateAttempt.payload,
            responseStatus: updateAttempt.response.status,
            resolvedError: resolvedChannel.resolveError,
            channel: channelToUse,
          }),
        };
      }
    }

    const postAttempt = await slackWriteRequestWithJoin(token, "chat.postMessage", {
      channel: channelToUse,
      text,
    });

    if (postAttempt.response.ok && postAttempt.payload.ok === true) {
      if (typeof postAttempt.payload.ts === "string") {
        await setSlackStatusMessageTs(postAttempt.payload.ts);
      }

      return { ok: true };
    }

    return {
      ok: false,
      error: formatSlackErrorMessage({
        payload: postAttempt.payload,
        responseStatus: postAttempt.response.status,
        resolvedError: resolvedChannel.resolveError,
        channel: channelToUse,
      }),
    };
  } catch {
    return { ok: false, error: "Could not reach Slack API." };
  }
}

export function verifySlackRequest({
  rawBody,
  timestamp,
  signature,
}: VerifyRequestParams) {
  if (process.env.SLACK_DISABLE_SIGNATURE_VERIFICATION === "true") {
    return true;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    return true;
  }

  if (!timestamp || !signature) {
    return false;
  }

  const parsedTimestamp = Number(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowInSeconds - parsedTimestamp) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expectedSignature = `v0=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
