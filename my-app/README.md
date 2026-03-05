# Staging Tracker

Glass dashboard with:

- Left: users
- Right: 4 staging cards (`backend`, `payer-app`, `payer-web`, `business-web`)

Users come from a local JSON file (`src/data/users.json`), and you can drag cards between zones.
Each staging card supports a maximum of 1 user.
A single user can be assigned to multiple staging cards at the same time.

When a user moves:

- the app updates one Slack status message (instead of posting a new message each time)
- message format:
  - `Environments:`
  - `Backend: Free to use` or `Backend: <name> is using it`
  - same for the other cards

There is also a Slack slash command endpoint for:

- `/staging-status`
- `/staging-take {environment}`
- `/staging-remove`

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
SLACK_STATUS_MESSAGE_TS=
SLACK_DISABLE_SIGNATURE_VERIFICATION=false
```

`SLACK_CHANNEL` should be the channel ID (recommended), not `#name`.
To get it in Slack: open the channel -> click channel name -> copy **Channel ID**.

`SLACK_STATUS_MESSAGE_TS` is optional.
If set, the app will update that exact Slack message.
If empty, the app creates one status message and stores its `ts` internally.

If slash command debugging is blocked by signature mismatch in local/dev, you can set:

`SLACK_DISABLE_SIGNATURE_VERIFICATION=true`

Do not use that in production.

## Slack app setup

1. Go to `https://api.slack.com/apps` and click **Create New App**.
2. Choose **From scratch**.
3. Name it (for example, `staging-notifier`) and select your workspace.
4. Open **OAuth & Permissions** and add bot scopes `chat:write` and `commands`.
5. Add `users:read` if you want full-name lookup from Slack profiles.
6. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`).
7. Open **Basic Information** and copy the **Signing Secret**.
8. Open **Slash Commands** and create `/staging-status`.
9. Set Request URL to `https://YOUR_PUBLIC_DOMAIN/api/slack/commands`.
10. Create `/staging-take` with the same Request URL.
11. Create `/staging-remove` with the same Request URL.
12. Save changes.

## Onboard app to #coders

1. Invite the app to the channel.
2. In Slack, open `#coders` and run `/invite @your-app-name`.
3. Set `SLACK_CHANNEL` to the channel ID, for example `C0123456789`.
4. Restart the app.
5. Test with `/staging-status`.
6. Test `/staging-take backend` (or any environment).
7. Test `/staging-remove`.
8. Drag a user to any staging card and confirm the same status message in `#coders` is edited.

## Important note for local testing

Slack needs a public URL for slash commands/webhooks.
For local development, expose your app with a tunnel (for example `ngrok` or `cloudflared`) and use that HTTPS URL in the Slack command Request URL.

## Project structure

- `src/data/users.json`: user list (`name`, `picture`, `slack-name`, optional `slack-id`)
- `src/data/staging-state.json`: persisted current staging occupancy
- `src/types/staging.ts`: staging card names and shared types
- `src/app/api/staging/move/route.ts`: updates state + sends Slack message
- `src/app/api/slack/commands/route.ts`: handles `/staging-status`, `/staging-take`, and `/staging-remove`
- `src/components/staging-dashboard.tsx`: drag-and-drop UI
