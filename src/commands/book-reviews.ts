import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections, normalizeTitle } from "../book-club.js";
import { buildBookReviewsMessage } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("book-reviews")
  .setDescription("Read reviews members have left for a club book.")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("Choose a book from the club book list.")
      .setAutocomplete(true)
      .setRequired(true),
  );

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateChoiceValue(value: string) {
  return value.length > 100 ? value.slice(0, 100) : value;
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim();
  const { books } = getBookClubCollections();
  const query = focusedValue
    ? {
        documentType: "book" as const,
        guildId: interaction.guildId,
        $or: [
          { title: { $regex: escapeRegex(focusedValue), $options: "i" } },
          { author: { $regex: escapeRegex(focusedValue), $options: "i" } },
        ],
      }
    : {
        documentType: "book" as const,
        guildId: interaction.guildId,
      };

  const availableBooks = await books.find(query).collation({ locale: "en", strength: 2 }).sort({ title: 1 }).limit(25).toArray();

  await interaction.respond(
    availableBooks.map((book) => ({
      name: truncateChoiceValue(formatBookTitle(book.title, book.author)),
      value: truncateChoiceValue(book.normalizedTitle),
    })),
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const titleInput = interaction.options.getString("title", true).trim();
  const { books } = getBookClubCollections();
  const normalizedTitle = normalizeTitle(titleInput);
  const book = await books.findOne({
    documentType: "book",
    guildId: interaction.guildId,
    normalizedTitle,
  });

  if (!book) {
    await interaction.reply({
      content: "That book is not in the club book list yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const message = await buildBookReviewsMessage(interaction.guildId, book._id.toString(), 0);
  if (message.totalReviews === 0) {
    await interaction.editReply({
      content: `No one has left a review for **${formatBookTitle(book.title, book.author)}** yet.`,
    });
    return;
  }

  await interaction.editReply({
    embeds: message.embeds,
    components: message.components,
  });
}
