# Staging Tracker

Glass dashboard with:

- Left: users
- Right: 3 staging cards (`backend`, `payer-web`, `business-web`)

Users come from a local JSON file (`src/data/users.json`), and you can drag cards between zones.
Each staging card supports a maximum of 1 user.
A single user can be assigned to multiple staging cards at the same time.

When a user moves:

- taking an environment posts `@here <name> is now using Staging *<environment>*` in `#coders`
- releasing an environment posts `@here Staging *<environment>* is free now` in `#coders`
- Slack notification failures do not roll back successful staging changes

There is also a Slack slash command endpoint for:

- `/staging-take {environment}`
- `/staging-remove`

State is stored in Upstash Redis when its credentials are configured. Local development
falls back to `src/data/staging-state.json` when Redis is not configured.

## Local development

```bash
pnpm install
# create .env.local with the variables below
pnpm dev
```

Open `http://localhost:3000`.

## Environment variables

Create `.env.local`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CHANNEL=C0123456789
SLACK_DISABLE_SIGNATURE_VERIFICATION=false
UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-upstash-token
# Optional; defaults to staging-notifier:state
STAGING_STATE_REDIS_KEY=staging-notifier:state
```

`SLACK_CHANNEL` should be the channel ID (recommended), not `#name`.
To get it in Slack: open the channel -> click channel name -> copy **Channel ID**.

Upstash Redis is recommended locally and required for persistent state on serverless
deployments such as Vercel. Without Redis, local development uses the JSON state file.

If slash command debugging is blocked by signature mismatch in local/dev, you can set:

`SLACK_DISABLE_SIGNATURE_VERIFICATION=true`

Do not use that in production.

## Slack app setup

1. Go to `https://api.slack.com/apps` and click **Create New App**.
2. Choose **From scratch**.
3. Name it (for example, `staging-notifier`) and select your workspace.
4. Open **OAuth & Permissions** and add bot scopes `chat:write` and `commands`.
5. Add `users:read` if you want full-name lookup from Slack profiles.
6. Add `channels:read` only if `SLACK_CHANNEL` uses a channel name instead of the recommended ID.
7. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`).
8. Open **Basic Information** and copy the **Signing Secret**.
9. Open **Slash Commands** and create `/staging-take`.
10. Set Request URL to `https://YOUR_PUBLIC_DOMAIN/api/slack/commands`.
11. Create `/staging-remove` with the same Request URL.
12. Save changes.

## Onboard app to #coders

1. Invite the app to the channel.
2. In Slack, open `#coders` and run `/invite @your-app-name`.
3. Set `SLACK_CHANNEL` to the channel ID, for example `C0123456789`.
4. Restart the app.
5. Test `/staging-take backend` (or any environment) and confirm a new `@here` message is posted.
6. Test `/staging-remove` and confirm a new availability message is posted.
7. Drag a user to and from a staging card and confirm both messages in `#coders`.

## Important note for local testing

Slack needs a public URL for slash commands/webhooks.
For local development, expose your app with a tunnel (for example `ngrok` or `cloudflared`) and use that HTTPS URL in the Slack command Request URL.

## Project structure

- `src/data/users.json`: user list (`name`, `picture`, `slack-name`, optional `slack-id`)
- `src/data/staging-state.json`: local fallback for current staging occupancy
- `src/types/staging.ts`: staging card names and shared types
- `src/lib/staging-state.ts`: reads and writes occupancy in Redis or the local fallback
- `src/app/api/staging/move/route.ts`: updates state and posts Slack notifications
- `src/app/api/slack/commands/route.ts`: handles `/staging-take` and `/staging-remove`
- `src/components/staging-dashboard.tsx`: drag-and-drop UI
