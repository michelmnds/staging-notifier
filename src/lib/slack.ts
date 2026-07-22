import { createHmac, timingSafeEqual } from "node:crypto";
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
  channels?: Array<{
    id: string;
    name: string;
  }>;
};

type StagingChangeNotification = {
  userName: string;
  takenEnvironment: StagingEnvironment | null;
  releasedEnvironments: StagingEnvironment[];
};

const channelIdPattern = /^[CGD][A-Z0-9]{8,}$/;

function normalizeChannelInput(rawChannel: string) {
  const trimmed = rawChannel.trim();
  const channelMentionMatch = trimmed.match(/^<#([CGD][A-Z0-9]+)\|[^>]+>$/);

  if (channelMentionMatch) {
    return channelMentionMatch[1];
  }

  return trimmed;
}

function escapeSlackText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
    limit: 999,
    exclude_archived: true,
    types: "public_channel,private_channel",
  });

  if (payload.ok !== true || !Array.isArray(payload.channels)) {
    return {
      channelId: null,
      error: payload.error || "Could not list channels.",
    };
  }

  const match = payload.channels.find(
    (channel) => channel.name === normalizedName,
  );
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

  return (
    payload.error ||
    resolvedError ||
    `Slack HTTP ${responseStatus} (channel ${channel})`
  );
}

async function postSlackMessage(token: string, channel: string, text: string) {
  const firstTry = await slackJsonRequest(token, "chat.postMessage", {
    channel,
    text,
    unfurl_links: false,
  });

  if (firstTry.response.ok && firstTry.payload.ok === true) {
    return firstTry;
  }

  if (
    firstTry.payload.error === "not_in_channel" &&
    channelIdPattern.test(channel) &&
    channel.startsWith("C")
  ) {
    await slackJsonRequest(token, "conversations.join", { channel });
    return slackJsonRequest(token, "chat.postMessage", {
      channel,
      text,
      unfurl_links: false,
    });
  }

  return firstTry;
}

export async function postStagingChangeNotifications({
  userName,
  takenEnvironment,
  releasedEnvironments,
}: StagingChangeNotification): Promise<SlackResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL || "#coders";

  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN is missing." };
  }

  const messages = [
    takenEnvironment
      ? `<!here> ${escapeSlackText(userName)} is now using Staging *${takenEnvironment}*`
      : null,
    releasedEnvironments.length > 0
      ? releasedEnvironments
          .map((environment) => `<!here> staging *${environment}* is free now`)
          .join("\n")
      : null,
  ].filter((message): message is string => message !== null);

  if (messages.length === 0) {
    return { ok: true };
  }

  try {
    const resolvedChannel = await resolveChannelId(token, channel);

    const attempts = await Promise.all(
      messages.map((text) =>
        postSlackMessage(token, resolvedChannel.channelId, text),
      ),
    );
    const failedAttempt = attempts.find(
      (attempt) => !attempt.response.ok || attempt.payload.ok !== true,
    );

    if (failedAttempt) {
      return {
        ok: false,
        error: formatSlackErrorMessage({
          payload: failedAttempt.payload,
          responseStatus: failedAttempt.response.status,
          resolvedError: resolvedChannel.resolveError,
          channel: resolvedChannel.channelId,
        }),
      };
    }

    return { ok: true };
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
