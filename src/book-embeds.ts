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
    embed.setThumbnail(options.imageUrl);
    embed.addFields({ name: "Cover", value: `[Open image](${options.imageUrl})`, inline: true });
  }

  if (options.footerText) {
    embed.setFooter({ text: options.footerText });
  }

  return embed;
}
