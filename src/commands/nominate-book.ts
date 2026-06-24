import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import {
  NominationDocument,
  PollDocument,
  PollOption,
  formatBookTitle,
  getBookClubCollections,
  getImageUrlOrNull,
  normalizeTitle,
} from "../book-club.js";
import { buildPollComponents, buildPollEmbed, getMaxPollOptions } from "../polls.js";

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

function buildPollOption(nomination: NominationDocument): PollOption {
  return {
    nominationId: nomination.nominationId,
    title: nomination.title,
    normalizedTitle: nomination.normalizedTitle,
    author: nomination.author,
    nominatedBy: nomination.nominatedBy,
    reason: nomination.reason,
    imageUrl: nomination.imageUrl,
  };
}

async function refreshPollMessage(interaction: ChatInputCommandInteraction, poll: PollDocument) {
  if (!poll.messageId) return;

  const channel =
    poll.channelId === interaction.channelId
      ? interaction.channel
      : await interaction.client.channels.fetch(poll.channelId).catch(() => null);

  if (!channel?.isTextBased()) return;

  const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
  await pollMessage?.edit({
    embeds: [buildPollEmbed(poll)],
    components: buildPollComponents(poll),
  });
}

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

  const { nominations, polls } = getBookClubCollections();
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

  const nomination = await nominations.findOne({
    guildId: interaction.guildId,
    normalizedTitle,
    status: "nominated",
  });

  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });
  let pollText = "";

  if (nomination && activePoll) {
    const pollOption = buildPollOption(nomination);
    const optionIndex = activePoll.options.findIndex((option) => option.normalizedTitle === normalizedTitle);

    if (optionIndex >= 0) {
      await polls.updateOne(
        { pollId: activePoll.pollId, guildId: interaction.guildId },
        {
          $set: {
            [`options.${optionIndex}`]: pollOption,
            updatedAt: now,
          },
        },
      );
      pollText = "\nUpdated this book in the active poll.";
    } else if (activePoll.options.length >= getMaxPollOptions()) {
      pollText = `\nThe active poll already has ${getMaxPollOptions()} books, so this nomination was saved for the next poll.`;
    } else {
      await polls.updateOne(
        { pollId: activePoll.pollId, guildId: interaction.guildId },
        {
          $push: {
            options: pollOption,
          },
          $set: {
            updatedAt: now,
          },
        },
      );
      pollText = "\nAdded this book to the active poll.";
    }

    const updatedPoll = await polls.findOne({ pollId: activePoll.pollId, guildId: interaction.guildId });
    if (updatedPoll) {
      await refreshPollMessage(interaction, updatedPoll);
    }
  }

  const action = result.upsertedCount > 0 ? "Nominated" : "Updated the nomination for";
  const imageText = imageUrl ? `\nCover: ${imageUrl}` : "";
  await interaction.reply(`${action} **${formatBookTitle(title, author)}**.${imageText}${pollText}`);
}
