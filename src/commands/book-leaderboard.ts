import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import {
  buildBookLeaderboardMessage,
  isBookLeaderboardRanking,
} from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("book-leaderboard")
  .setDescription("Rank club books by rating, popularity, or rating spread.")
  .addStringOption((option) =>
    option
      .setName("ranking")
      .setDescription("How to rank the books. Defaults to highest rated.")
      .addChoices(
        { name: "Highest Rated", value: "highest-rated" },
        { name: "Most Rated", value: "most-rated" },
        { name: "Most Divisive", value: "most-divisive" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const requestedRanking = interaction.options.getString("ranking") ?? "highest-rated";
  const ranking = isBookLeaderboardRanking(requestedRanking) ? requestedRanking : "highest-rated";

  await interaction.deferReply();

  const message = await buildBookLeaderboardMessage(interaction.guildId, 0, ranking);

  if (message.totalBooks === 0) {
    await interaction.editReply({
      content:
        ranking === "most-divisive"
          ? "No books have enough ratings to measure rating spread yet. Each book needs at least two ratings."
          : "No books have ratings yet.",
    });
    return;
  }

  await interaction.editReply({
    embeds: message.embeds,
    components: message.components,
  });
}
