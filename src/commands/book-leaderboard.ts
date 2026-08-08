import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { buildBookLeaderboardMessage } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("book-leaderboard")
  .setDescription("Show the highest rated club books.");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const message = await buildBookLeaderboardMessage(interaction.guildId, 0);

  if (message.totalBooks === 0) {
    await interaction.editReply({
      content: "No books have ratings yet.",
    });
    return;
  }

  await interaction.editReply({
    embeds: message.embeds,
    components: message.components,
  });
}
