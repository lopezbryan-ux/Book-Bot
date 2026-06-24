import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections } from "../book-club.js";

export const data = new SlashCommandBuilder()
  .setName("book-list")
  .setDescription("Show the books selected by the club.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { books } = getBookClubCollections();
  const selectedBooks = await books
    .find({ documentType: "book", guildId: interaction.guildId })
    .sort({ selectedAt: -1 })
    .limit(20)
    .toArray();

  if (selectedBooks.length === 0) {
    await interaction.reply({ content: "No books have been added to the club list yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  const list = selectedBooks
    .map((book, index) => `${index + 1}. **${formatBookTitle(book.title, book.author)}**`)
    .join("\n");

  await interaction.reply(`**Book Club List**\n${list}`);
}
