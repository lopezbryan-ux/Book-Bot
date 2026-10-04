---
name: book-bot-pm2
description: Start or restart Book-Bot with PM2 so Discord runs the updated code and commands.
---

# Book-Bot PM2 workflow

Run commands from the Book-Bot repository directory.

## Start the bot

For the initial PM2 start, use:

```bash
pm2 start npm --name book-bot -- run cleanrun
```

The equivalent command for the separate StrengthBot project, run from its own repository, is:

```bash
pm2 start npm --name strengthbot -- run cleanrun
```

`--name` sets the PM2 process name. `-- run cleanrun` passes `run cleanrun` to npm.

## Apply changes to the running bot

Check whether Book-Bot already has a PM2 process:

```bash
pm2 list
```

If it already exists, restart that process instead of creating another:

```bash
pm2 restart book-bot
```

The process launched with the start command above reruns `cleanrun` on restart. In this repository, `cleanrun` executes these steps in order:

1. `git pull` fetches and integrates the latest changes from the configured upstream.
2. `rm -rf dist` removes the previous compiled output.
3. `npm run build` compiles TypeScript.
4. `npm run deploy-commands` registers Discord commands.
5. `node dist/index.js` runs the updated bot.

Each step must succeed before the next runs. Changes made elsewhere must be committed and pushed to the branch used by the bot's checkout before restarting to retrieve them. Local source changes are included in the rebuild if the pull succeeds; check for uncommitted changes before pulling.

After starting or restarting, confirm the process status and inspect startup output:

```bash
pm2 status book-bot
pm2 logs book-bot --lines 50 --nostream
```

Inspect `package.json` if the scripts change. Creating or editing this skill does not itself request a live bot restart; run the workflow when the user requests starting, restarting, or deploying the bot.
