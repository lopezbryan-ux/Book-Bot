---
name: book-bot-pm2
description: Deploy, start, or restart Book-Bot through PM2 when the user asks to deploy changes or restart the bot.
---

# Deploy Book-Bot

Run commands from the Book-Bot repository directory.

## Deploy changes to the existing bot

When the user says **"deploy them," "deploy the changes," or "restart the bot,"** and the `book-bot` PM2 process is already known to exist, the next deployment action is:

```bash
pm2 restart book-bot
```

Use process information already established in the conversation. Extra PM2 metadata inspection (`pm2 jlist`, environment dumps, or process descriptions) is unnecessary for this routine restart. Inspect further only if the restart fails or the deployment setup has changed.

If process existence is unknown, check once:

```bash
pm2 status book-bot
```

Restart the existing process. Use the first-start command below only when `book-bot` does not exist.

## What the restart deploys

The existing process runs `npm run cleanrun`, so restarting performs these steps automatically:

1. `git pull` fetches and integrates the latest changes from the configured upstream.
2. `rm -rf dist` removes the previous compiled output.
3. `npm run build` compiles TypeScript.
4. `npm run deploy-commands` registers Discord commands.
5. `node dist/index.js` runs the updated bot.

Local source edits in this checkout are included in the rebuild if the pull succeeds; committing and pushing those edits is not a prerequisite for local deployment. Changes made in another checkout must be committed and pushed to the branch this bot pulls. Use the known working-tree state, or check `git status --short` if it is unknown.

The restart handles building and Discord command registration. Separate build or registration commands are needed only when troubleshooting. Inspect `package.json` if the scripts have changed.

## Verify deployment after restarting

```bash
pm2 status book-bot
pm2 logs book-bot --lines 50 --nostream
```

Confirm the latest startup completed the build, printed `Successfully reloaded application (/) commands.`, and reached `Ready! Logged in as ...`. PM2 reporting `online` alone does not confirm startup finished. Distinguish older log errors from errors produced by this restart. If startup fails, inspect the failing step before restarting again.

## First start only

When no `book-bot` PM2 process exists:

```bash
pm2 start npm --name book-bot -- run cleanrun
```

For an explicitly requested first start of the separate StrengthBot project, run `pm2 start npm --name strengthbot -- run cleanrun` from its own repository.

Creating or editing this skill does not request a live deployment. Run the workflow when the user asks to start, restart, or deploy the bot.
