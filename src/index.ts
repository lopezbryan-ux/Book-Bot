import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mongoClient } from './mongo.js';
import { handleBookPollVote, isBookPollVoteCustomId } from './polls.js';
import {
  handleBookLeaderboardPage,
  handleRatingListPage,
  isBookLeaderboardPageCustomId,
  isRatingListPageCustomId,
} from './rating-views.js';
// Create a new client instance
interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

interface ExtendedClient extends Client {
  commands: Collection<string, Command>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export { mongoClient };

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  throw new Error('DISCORD_TOKEN is missing from the environment.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
}) as ExtendedClient;

client.commands = new Collection();

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

function isCommand(value: unknown): value is Command {
  if (typeof value !== 'object' || value === null || !('data' in value) || !('execute' in value)) {
    return false;
  }

  const command = value as { data?: { name?: unknown }; execute?: unknown };
  return typeof command.data?.name === 'string' && typeof command.execute === 'function';
}

function getCommand(commandModule: Record<string, unknown>): Command | undefined {
  const namedCommand = {
    data: commandModule.data,
    execute: commandModule.execute,
    autocomplete: commandModule.autocomplete,
  };

  return [commandModule.default, namedCommand, ...Object.values(commandModule)].find(isCommand);
}

(async () => {
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = getAllCommandFiles(commandsPath);

  for (const filePath of commandFiles) {
    const commandModule = await import(pathToFileURL(filePath).href);
    const command = getCommand(commandModule);
    if (command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }

  // When the client is ready, run this code (only once).
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  });

  // Listen for interactions (slash commands)
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command?.autocomplete) {
          await interaction.respond([]);
          return;
        }

        await command.autocomplete(interaction);
        return;
      }

      if (interaction.isChatInputCommand()) {
        console.log(`Received /${interaction.commandName}`);
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        await command.execute(interaction);
        return;
      }

      if (interaction.isButton() && isBookPollVoteCustomId(interaction.customId)) {
        await handleBookPollVote(interaction);
        return;
      }

      if (interaction.isButton() && isRatingListPageCustomId(interaction.customId)) {
        await handleRatingListPage(interaction);
        return;
      }

      if (interaction.isButton() && isBookLeaderboardPageCustomId(interaction.customId)) {
        await handleBookLeaderboardPage(interaction);
      }
    } catch (error) {
      console.error(error);
      if (!interaction.isRepliable()) return;

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  });

  client.login(TOKEN);
})();
