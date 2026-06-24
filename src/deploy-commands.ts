import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

interface DeployableCommand {
  data: {
    name?: string;
    toJSON: () => unknown;
  };
}

const commands: unknown[] = [];

function getAllCommandFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllCommandFiles(filePath));
    } else if (file.endsWith('.js')) {
      results.push(filePath);
    }
  }
  return results;
}

function isDeployableCommand(value: unknown): value is DeployableCommand {
  if (typeof value !== 'object' || value === null || !('data' in value)) return false;

  const data = (value as { data?: { toJSON?: unknown } }).data;
  return typeof data?.toJSON === 'function';
}

function getDeployableCommand(commandModule: Record<string, unknown>): DeployableCommand | undefined {
  const namedCommand = { data: commandModule.data };

  return [commandModule.default, namedCommand, ...Object.values(commandModule)].find(isDeployableCommand);
}

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = getAllCommandFiles(commandsPath);

async function loadCommands() {
  for (const filePath of commandFiles) {
    const commandModule = await import(pathToFileURL(filePath).href);
    const command = getDeployableCommand(commandModule);
    if (command) {
      commands.push(command.data.toJSON());
    }
  }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

(async () => {
  try {
    await loadCommands();
    console.log(`Started refreshing ${commands.length} application (/) command(s).`);

    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), { body: commands });

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
