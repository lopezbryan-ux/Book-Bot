import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { getBookClubCollections } from "../book-club.js";

export const data = new SlashCommandBuilder()
  .setName("book-list")
  .setDescription("Show the books selected by the club.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { books } = getBookClubCollections();
  const selectedBooks = await books
    .find({ documentType: "book", guildId: interaction.guildId })
    .sort({ selectedAt: 1 })
    .limit(20)
    .toArray();

  if (selectedBooks.length === 0) {
    await interaction.reply({ content: "No books have been added to the club list yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle("Book Club List")
    .setDescription("Selected books, from first added to latest.")
    .addFields(
      selectedBooks.map((book, index) => ({
        name: `${index + 1}. ${book.title.slice(0, 240)}`,
        value: book.author ? `by **${book.author.slice(0, 180)}**` : "Author not listed",
      })),
    )
    .setFooter({
      text: `${selectedBooks.length} book${selectedBooks.length === 1 ? "" : "s"} shown | Oldest to newest`,
    });

  await interaction.reply({ embeds: [embed] });
}
