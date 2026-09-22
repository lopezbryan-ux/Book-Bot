import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { getBookClubCollections } from "../book-club.js";
import { closeActiveBookPolls } from "../poll-closing.js";

export const data = new SlashCommandBuilder()
  .setName("close-book-poll")
  .setDescription("Close the active book poll you created.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { polls } = getBookClubCollections();
  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });

  if (!activePoll) {
    await interaction.reply({ content: "There are no active polls to close.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (activePoll.createdBy !== interaction.user.id) {
    await interaction.reply({
      content: "Only the person who created this poll can close it.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = await closeActiveBookPolls({
    client: interaction.client,
    createdBy: interaction.user.id,
    guildId: interaction.guildId,
    pollId: activePoll.pollId,
  });

  if (result.closedCount === 0) {
    await interaction.reply({ content: "There are no active polls to close.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply(
    `Closed ${result.closedCount} active poll${result.closedCount === 1 ? "" : "s"} and cleared ${
      result.clearedNominationCount
    } nomination${result.clearedNominationCount === 1 ? "" : "s"}.\n${result.summaries.join("\n")}`,
  );
}
