import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections, normalizeTitle } from "../book-club.js";

export const data = new SlashCommandBuilder()
  .setName("add-book")
  .setDescription("Manually add a selected book to the club book list.")
  .addStringOption((option) =>
    option.setName("title").setDescription("The title of the book to add.").setRequired(true),
  )
  .addStringOption((option) => option.setName("author").setDescription("The book author.").setMaxLength(200))
  .addStringOption((option) =>
    option.setName("note").setDescription("Optional note, like when the club read it.").setMaxLength(1000),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const author = interaction.options.getString("author")?.trim() || null;
  const note = interaction.options.getString("note")?.trim() || null;

  if (!title) {
    await interaction.reply({ content: "Give me a book title to add.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { books } = getBookClubCollections();
  const now = new Date();
  const result = await books.updateOne(
    {
      documentType: "book",
      guildId: interaction.guildId,
      normalizedTitle: normalizeTitle(title),
    },
    {
      $set: {
        documentType: "book",
        guildId: interaction.guildId,
        title,
        normalizedTitle: normalizeTitle(title),
        author,
        source: "manual",
        sourcePollId: null,
        note,
        addedBy: interaction.user.id,
        addedByUsername: interaction.user.username,
        updatedAt: now,
      },
      $setOnInsert: {
        selectedAt: now,
      },
    },
    { upsert: true },
  );

  const action = result.upsertedCount > 0 ? "Added" : "Updated";
  await interaction.reply(`${action} **${formatBookTitle(title, author)}** in the club book list.`);
}
