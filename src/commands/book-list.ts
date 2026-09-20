import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookListMessage } from "../book-list-view.js";

export const data = new SlashCommandBuilder()
  .setName("book-list")
  .setDescription("Show the books selected by the club.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const message = await buildBookListMessage(interaction.guildId);

  if (!message) {
    await interaction.reply({ content: "No books have been added to the club list yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply(message);
}
