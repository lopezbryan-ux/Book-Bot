import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { replyWithHelp } from "../help.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show BookBot commands and what they do.")
  .addIntegerOption((option) =>
    option.setName("page").setDescription("The help page to show.").setMinValue(1),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const page = interaction.options.getInteger("page") ?? 1;
  await replyWithHelp(interaction, page - 1);
}
