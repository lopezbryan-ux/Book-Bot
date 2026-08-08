import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Collection,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

const HELP_PAGE_PREFIX = "book-help";
const COMMANDS_PER_HELP_PAGE = 5;

interface HelpCommand {
  data: {
    name: string;
    description?: string;
    toJSON?: () => { name?: string; description?: string };
  };
}

interface HelpClient extends Client {
  commands?: Collection<string, HelpCommand>;
}

function buildHelpPageCustomId(page: number) {
  return `${HELP_PAGE_PREFIX}:${page}`;
}

export function isHelpPageCustomId(customId: string) {
  return customId.startsWith(`${HELP_PAGE_PREFIX}:`);
}

function getHelpCommands(client: Client) {
  const commands = (client as HelpClient).commands;
  if (!commands) return [];

  return Array.from(commands.values())
    .map((command) => {
      const commandJson = command.data.toJSON?.();
      return {
        name: commandJson?.name ?? command.data.name,
        description: commandJson?.description ?? command.data.description ?? "No description available.",
      };
    })
    .filter((command) => command.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildHelpMessage(client: Client, page: number) {
  const commands = getHelpCommands(client);
  const totalPages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_HELP_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageCommands = commands.slice(safePage * COMMANDS_PER_HELP_PAGE, (safePage + 1) * COMMANDS_PER_HELP_PAGE);

  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle("BookBot Help")
    .setDescription(commands.length === 0 ? "No commands are loaded." : "Commands available in this server.")
    .setFooter({ text: `Page ${safePage + 1} of ${totalPages}` });

  for (const command of pageCommands) {
    embed.addFields({
      name: `/${command.name}`,
      value: command.description,
    });
  }

  const components =
    totalPages > 1
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildHelpPageCustomId(safePage - 1))
              .setLabel("Prev")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId(buildHelpPageCustomId(safePage))
              .setLabel(`${safePage + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(buildHelpPageCustomId(safePage + 1))
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= totalPages - 1),
          ),
        ]
      : [];

  return { embeds: [embed], components };
}

export async function replyWithHelp(interaction: ChatInputCommandInteraction, page: number) {
  await interaction.reply({
    ...buildHelpMessage(interaction.client, page),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHelpPage(interaction: ButtonInteraction) {
  const [, pageText] = interaction.customId.split(":");
  const page = Number(pageText);

  if (!Number.isInteger(page)) {
    await interaction.reply({ content: "That help page button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.update(buildHelpMessage(interaction.client, page));
}
