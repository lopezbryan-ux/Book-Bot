import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import { formatBookTitle, getBookClubCollections, getImageUrlOrNull, normalizeTitle } from "../book-club.js";

export const data = new SlashCommandBuilder()
  .setName("nominate-book")
  .setDescription("Nominate a book for the next club poll.")
  .addStringOption((option) =>
    option.setName("title").setDescription("The title of the book you want to nominate.").setRequired(true),
  )
  .addStringOption((option) => option.setName("author").setDescription("The book author.").setMaxLength(200))
  .addStringOption((option) =>
    option.setName("reason").setDescription("Why you think the club should read it.").setMaxLength(1000),
  )
  .addStringOption((option) =>
    option.setName("image-url").setDescription("Optional book cover image URL.").setMaxLength(1000),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const author = interaction.options.getString("author")?.trim() || null;
  const reason = interaction.options.getString("reason")?.trim() || null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() || null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  if (!title) {
    await interaction.reply({ content: "Give me a book title to nominate.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (imageUrlInput && !imageUrl) {
    await interaction.reply({
      content: "That image URL does not look valid. Use a full `https://...` or `http://...` URL.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { nominations } = getBookClubCollections();
  const now = new Date();
  const normalizedTitle = normalizeTitle(title);

  const result = await nominations.updateOne(
    {
      guildId: interaction.guildId,
      normalizedTitle,
      status: "nominated",
    },
    {
      $set: {
        title,
        normalizedTitle,
        author,
        reason,
        imageUrl,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        nominatedBy: interaction.user.id,
        nominatedByUsername: interaction.user.username,
        updatedAt: now,
      },
      $setOnInsert: {
        nominationId: randomUUID(),
        documentType: "nomination",
        status: "nominated",
        createdAt: now,
      },
    },
    { upsert: true },
  );

  const action = result.upsertedCount > 0 ? "Nominated" : "Updated the nomination for";
  const imageText = imageUrl ? `\nCover: ${imageUrl}` : "";
  await interaction.reply(`${action} **${formatBookTitle(title, author)}**.${imageText}`);
}
