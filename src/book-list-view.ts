import {
  ActionRowBuilder,
  EmbedBuilder,
  escapeMarkdown,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { BookDocument, getBookClubCollections } from "./book-club.js";

const BOOK_LIST_SORT_CUSTOM_ID = "book-list-sort";
const BOOK_LIST_LIMIT = 20;

const bookListSorts = {
  "added-oldest": {
    label: "Oldest added first",
    menuDescription: "Start with the club's earliest selection",
    emoji: "🕰️",
    description: "From the club's first selection to its latest.",
    footer: "Oldest to newest",
    sort: { selectedAt: 1, _id: 1 },
  },
  "added-newest": {
    label: "Newest added first",
    menuDescription: "Put the latest club selections on top",
    emoji: "✨",
    description: "The club's latest selections are on top.",
    footer: "Newest to oldest",
    sort: { selectedAt: -1, _id: 1 },
  },
  "title-az": {
    label: "Title · A to Z",
    menuDescription: "Browse titles alphabetically",
    emoji: "🔤",
    description: "Browse the shelf alphabetically by title.",
    footer: "Title A to Z",
    sort: { normalizedTitle: 1, _id: 1 },
  },
  "title-za": {
    label: "Title · Z to A",
    menuDescription: "Browse titles in reverse order",
    emoji: "🔡",
    description: "Browse the shelf in reverse order by title.",
    footer: "Title Z to A",
    sort: { normalizedTitle: -1, _id: 1 },
  },
  "author-az": {
    label: "Author · A to Z",
    menuDescription: "Browse authors alphabetically",
    emoji: "✒️",
    description: "Browse the shelf alphabetically by author.",
    footer: "Author A to Z",
    sort: { author: 1, normalizedTitle: 1, _id: 1 },
  },
  "author-za": {
    label: "Author · Z to A",
    menuDescription: "Browse authors in reverse order",
    emoji: "🖋️",
    description: "Browse the shelf in reverse order by author.",
    footer: "Author Z to A",
    sort: { author: -1, normalizedTitle: 1, _id: 1 },
  },
} as const;

export type BookListSort = keyof typeof bookListSorts;

function isBookListSort(value: string): value is BookListSort {
  return value in bookListSorts;
}

function buildSortMenu(selectedSort: BookListSort) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(BOOK_LIST_SORT_CUSTOM_ID)
    .setPlaceholder("Rearrange the shelf…")
    .addOptions(
      Object.entries(bookListSorts).map(([value, option]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(value)
          .setDescription(option.menuDescription)
          .setEmoji(option.emoji)
          .setDefault(value === selectedSort),
      ),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function isBookListSortCustomId(customId: string) {
  return customId === BOOK_LIST_SORT_CUSTOM_ID;
}

function formatBookDetails(book: BookDocument) {
  const author = book.author ? `by **${escapeMarkdown(book.author).slice(0, 180)}**` : "*Author not listed*";
  const selectedAt = book.selectedAt instanceof Date ? book.selectedAt.getTime() : Number.NaN;

  if (!Number.isFinite(selectedAt)) {
    return author;
  }

  return `${author}  ·  Added <t:${Math.floor(selectedAt / 1000)}:d>`;
}

export async function buildBookListMessage(guildId: string | null, selectedSort: BookListSort = "added-oldest") {
  const { books } = getBookClubCollections();
  const sortOption = bookListSorts[selectedSort];
  const selectedBooks = await books
    .find({ documentType: "book", guildId })
    .sort(sortOption.sort)
    .limit(BOOK_LIST_LIMIT)
    .toArray();

  if (selectedBooks.length === 0) {
    return null;
  }

  const embed = new EmbedBuilder()
    .setColor(0xb8894b)
    .setTitle("📚  Book Club Library")
    .setDescription(`*${sortOption.description}*\nUse the menu below to rearrange the shelf.`)
    .addFields(
      selectedBooks.map((book: BookDocument, index: number) => ({
        name: `${String(index + 1).padStart(2, "0")}  •  ${escapeMarkdown(book.title).slice(0, 235)}`,
        value: formatBookDetails(book),
      })),
    )
    .setFooter({
      text: `${selectedBooks.length} book${selectedBooks.length === 1 ? "" : "s"} on this shelf  •  ${sortOption.footer}`,
    });

  return { embeds: [embed], components: [buildSortMenu(selectedSort)] };
}

export async function handleBookListSort(interaction: StringSelectMenuInteraction) {
  const selectedSort = interaction.values[0];
  if (!selectedSort || !isBookListSort(selectedSort)) {
    throw new Error("Invalid book list sort option.");
  }

  await interaction.deferUpdate();
  const message = await buildBookListMessage(interaction.guildId, selectedSort);

  if (!message) {
    await interaction.editReply({ content: "No books have been added to the club list yet.", embeds: [], components: [] });
    return;
  }

  await interaction.editReply(message);
}
