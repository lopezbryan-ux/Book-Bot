import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { closeActiveBookPolls } from "../poll-closing.js";

export const data = new SlashCommandBuilder()
  .setName("close-book-poll")
  .setDescription("Close every active book poll.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const result = await closeActiveBookPolls({
    client: interaction.client,
    guildId: interaction.guildId,
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
