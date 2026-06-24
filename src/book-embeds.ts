import { EmbedBuilder, User } from "discord.js";

interface BookAddedEmbedOptions {
  action: string;
  title: string;
  author: string | null;
  imageUrl: string | null;
  note: string | null;
  addedBy?: User;
  footerText?: string;
}

interface BookRatingEmbedOptions {
  heading?: string;
  title: string;
  author: string | null;
  imageUrl: string | null;
  rating: number;
  averageRating?: number;
  ratingCount?: number;
  review: string | null;
  ratedBy: User;
}

interface RatingRemovedEmbedOptions {
  title: string;
  author: string | null;
  imageUrl: string | null;
  removedBy: User;
}

export function buildBookAddedEmbed(options: BookAddedEmbedOptions) {
  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle(options.action)
    .setDescription(`**${options.title}**`)
    .setTimestamp();

  if (options.author) {
    embed.addFields({ name: "Author", value: options.author, inline: true });
  }

  if (options.note) {
    embed.addFields({ name: "Note", value: options.note });
  }

  if (options.addedBy) {
    embed.addFields({ name: "Added by", value: options.addedBy.toString(), inline: true });
  }

  if (options.imageUrl) {
    embed.setImage(options.imageUrl);
  }

  if (options.footerText) {
    embed.setFooter({ text: options.footerText });
  }

  return embed;
}

export function buildBookRatingEmbed(options: BookRatingEmbedOptions) {
  const rating = Math.round(options.rating * 10) / 10;
  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle(options.title)
    .setDescription(options.author ? `by **${options.author}**` : options.heading ?? "Book rating")
    .setTimestamp();

  embed.addFields(
    { name: "Rating", value: `**${rating.toFixed(1)}/10**`, inline: true },
    { name: "Rated by", value: options.ratedBy.toString(), inline: true },
  );

  if (options.averageRating !== undefined && options.ratingCount !== undefined) {
    embed.addFields({
      name: "Club Average",
      value: `${options.averageRating.toFixed(1)}/10 from ${options.ratingCount} rating${
        options.ratingCount === 1 ? "" : "s"
      }`,
      inline: true,
    });
  }

  if (options.review) {
    embed.addFields({ name: "Review", value: options.review });
  }

  if (options.imageUrl) {
    embed.setThumbnail(options.imageUrl);
    embed.addFields({ name: "Cover", value: `[Open image](${options.imageUrl})`, inline: true });
  }

  return embed;
}

export function buildRatingRemovedEmbed(options: RatingRemovedEmbedOptions) {
  const embed = new EmbedBuilder()
    .setColor(0xb85c5c)
    .setTitle(options.title)
    .setDescription(options.author ? `by **${options.author}**` : "Rating removed")
    .addFields({ name: "Removed rating for", value: options.removedBy.toString(), inline: true })
    .setTimestamp();

  if (options.imageUrl) {
    embed.setThumbnail(options.imageUrl);
    embed.addFields({ name: "Cover", value: `[Open image](${options.imageUrl})`, inline: true });
  }

  return embed;
}
