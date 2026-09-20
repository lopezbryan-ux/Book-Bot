import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { BookDocument, getBookClubCollections } from "./book-club.js";

const BOOK_LIST_SORT_CUSTOM_ID = "book-list-sort";
const BOOK_LIST_LIMIT = 20;

const bookListSorts = {
  "added-oldest": {
    label: "Date added: Oldest first",
    description: "Selected books, from first added to latest.",
    footer: "Oldest to newest",
    sort: { selectedAt: 1, _id: 1 },
  },
  "added-newest": {
    label: "Date added: Newest first",
    description: "Selected books, from latest added to first.",
    footer: "Newest to oldest",
    sort: { selectedAt: -1, _id: 1 },
  },
  "title-az": {
    label: "Title: A to Z",
    description: "Selected books, sorted alphabetically by title.",
    footer: "Title A to Z",
    sort: { normalizedTitle: 1, _id: 1 },
  },
  "title-za": {
    label: "Title: Z to A",
    description: "Selected books, sorted reverse alphabetically by title.",
    footer: "Title Z to A",
    sort: { normalizedTitle: -1, _id: 1 },
  },
  "author-az": {
    label: "Author: A to Z",
    description: "Selected books, sorted alphabetically by author.",
    footer: "Author A to Z",
    sort: { author: 1, normalizedTitle: 1, _id: 1 },
  },
  "author-za": {
    label: "Author: Z to A",
    description: "Selected books, sorted reverse alphabetically by author.",
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
    .setPlaceholder("Sort the book list")
    .addOptions(
      Object.entries(bookListSorts).map(([value, option]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(value)
          .setDefault(value === selectedSort),
      ),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function isBookListSortCustomId(customId: string) {
  return customId === BOOK_LIST_SORT_CUSTOM_ID;
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
    .setColor(0x6f8f72)
    .setTitle("Book Club List")
    .setDescription(sortOption.description)
    .addFields(
      selectedBooks.map((book: BookDocument, index: number) => ({
        name: `${index + 1}. ${book.title.slice(0, 240)}`,
        value: book.author ? `by **${book.author.slice(0, 180)}**` : "Author not listed",
      })),
    )
    .setFooter({
      text: `${selectedBooks.length} book${selectedBooks.length === 1 ? "" : "s"} shown | ${sortOption.footer}`,
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
