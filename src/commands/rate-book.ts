import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildBookRatingEmbed } from '../book-embeds.js';
import { formatBookTitle, getBookClubCollections, normalizeTitle } from '../book-club.js';
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from '../mongo.js';

export const data = new SlashCommandBuilder()
  .setName('rate-book')
  .setDescription('Rate a book for the club.')
  .addStringOption((option) =>
    option
      .setName('title')
      .setDescription('Choose a book from the club book list.')
      .setAutocomplete(true)
      .setRequired(true),
  )
  .addNumberOption((option) =>
    option
      .setName('rating')
      .setDescription('Your rating out of 10, rounded to the nearest tenth.')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option.setName('review').setDescription('Optional notes about your rating.').setMaxLength(1000),
  );

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateChoiceValue(value: string) {
  return value.length > 100 ? value.slice(0, 100) : value;
}

function formatRating(rating: number) {
  return `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${rating}/5`;
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim();
  const { books } = getBookClubCollections();
  const query = focusedValue
    ? {
        documentType: 'book' as const,
        guildId: interaction.guildId,
        $or: [
          { title: { $regex: escapeRegex(focusedValue), $options: 'i' } },
          { author: { $regex: escapeRegex(focusedValue), $options: 'i' } },
        ],
      }
    : {
        documentType: 'book' as const,
        guildId: interaction.guildId,
      };

  const availableBooks = await books.find(query).sort({ selectedAt: -1 }).limit(25).toArray();

  await interaction.respond(
    availableBooks.map((book) => ({
      name: truncateChoiceValue(formatBookTitle(book.title, book.author)),
      value: truncateChoiceValue(book.normalizedTitle),
    })),
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const titleInput = interaction.options.getString('title', true).trim();
  const ratingInput = interaction.options.getNumber('rating', true);
  const rating = Math.round(ratingInput * 10) / 10;
  const review = interaction.options.getString('review')?.trim();

  const { books } = getBookClubCollections();
  const normalizedTitle = normalizeTitle(titleInput);
  const book = await books.findOne({
    documentType: 'book',
    guildId: interaction.guildId,
    normalizedTitle,
  });

  if (!book) {
    await interaction.reply({
      content: 'That book is not in the club book list yet. Add it with `/add-book` before rating it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection(BOOK_BOT_COLLECTION_NAME);
  const now = new Date();

  await ratings.updateOne(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      normalizedTitle: book.normalizedTitle,
    },
    {
      $set: {
        bookTitle: book.title,
        author: book.author,
        documentType: 'rating',
        normalizedTitle: book.normalizedTitle,
        rating,
        review: review || null,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        username: interaction.user.username,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );

  await interaction.reply({
    embeds: [
      buildBookRatingEmbed({
        title: book.title,
        author: book.author,
        imageUrl: book.imageUrl,
        rating,
        review: review || null,
        ratedBy: interaction.user,
      }),
    ],
  });
}

