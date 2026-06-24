import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookLeaderboardMessage } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("book-leaderboard")
  .setDescription("Show the highest rated club books.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const message = await buildBookLeaderboardMessage(interaction.guildId, 0);

  if (message.totalBooks === 0) {
    await interaction.reply({
      content: "No books have ratings yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: message.embeds,
    components: message.components,
  });
}
