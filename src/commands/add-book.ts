import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookAddedEmbed } from "../book-embeds.js";
import { getBookClubCollections, getImageUrlOrNull, normalizeTitle } from "../book-club.js";

export const data = new SlashCommandBuilder()
  .setName("add-book")
  .setDescription("Manually add a selected book to the club book list.")
  .addStringOption((option) =>
    option.setName("title").setDescription("The title of the book to add.").setRequired(true),
  )
  .addStringOption((option) => option.setName("author").setDescription("The book author.").setMaxLength(200))
  .addStringOption((option) =>
    option.setName("note").setDescription("Optional note, like when the club read it.").setMaxLength(1000),
  )
  .addStringOption((option) =>
    option.setName("image-url").setDescription("Optional book cover image URL.").setMaxLength(1000),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const author = interaction.options.getString("author")?.trim() || null;
  const note = interaction.options.getString("note")?.trim() || null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() || null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  if (!title) {
    await interaction.reply({ content: "Give me a book title to add.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (imageUrlInput && !imageUrl) {
    await interaction.reply({
      content: "That image URL does not look valid. Use a full `https://...` or `http://...` URL.",
      flags: MessageFlags.Ephemeral,
    });
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
        imageUrl,
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
  await interaction.reply({
    embeds: [
      buildBookAddedEmbed({
        action: `${action} to the club book list`,
        title,
        author,
        imageUrl,
        note,
        addedBy: interaction.user,
      }),
    ],
  });
}
