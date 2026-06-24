import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('rate-book')
  .setDescription('Rate a book for the club.')
  .addStringOption((option) =>
    option.setName('title').setDescription('The title of the book you want to rate.').setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName('rating')
      .setDescription('Your rating from 1 to 5.')
      .setMinValue(1)
      .setMaxValue(5)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option.setName('review').setDescription('Optional notes about your rating.').setMaxLength(1000),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString('title', true).trim();
  const rating = interaction.options.getInteger('rating', true);
  const review = interaction.options.getString('review')?.trim();

  const { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } = await import('../mongo.js');
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection(BOOK_BOT_COLLECTION_NAME);
  const now = new Date();

  await ratings.updateOne(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      normalizedTitle: title.toLowerCase(),
    },
    {
      $set: {
        bookTitle: title,
        documentType: 'rating',
        normalizedTitle: title.toLowerCase(),
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

  const reviewText = review ? `\nReview: ${review}` : '';
  await interaction.reply(`Saved ${interaction.user}'s rating for **${title}**: **${rating}/5**${reviewText}`);
}
