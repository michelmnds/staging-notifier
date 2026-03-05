import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getStagingOccupancy,
  getStagingState,
  setSlackStatusMessageTs,
} from "@/lib/staging-state";
import type { StagingEnvironment } from "@/types/staging";

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
  channels?: Array<{
    id: string;
    name: string;
  }>;
};

type OccupancyItem = {
  environment: StagingEnvironment;
  user: {
    name: string;
  } | null;
};

const channelIdPattern = /^[CGD][A-Z0-9]{8,}$/;
const environmentLabelByKey: Record<StagingEnvironment, string> = {
  backend: "Backend",
  "payer-app": "Payer App",
  "payer-web": "Payer Web",
  "business-web": "Business Web",
};

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

export function formatStagingStatusText(occupancy: OccupancyItem[]) {
  const lines = occupancy.map((item) => {
    const label = environmentLabelByKey[item.environment];

    if (!item.user) {
      return `• ${label}: Free to use`;
    }

    return `• ${label}: ${item.user.name} is using it`;
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
    const statusMessageTs = currentState.slackStatusMessageTs || fallbackTs;

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
