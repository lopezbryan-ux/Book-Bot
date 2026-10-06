# Book-Bot
Bot for my friends to use to view, store, nominate our books

Use `/update-book` to change an existing book's title, author, or cover image. Choose the book from the `title` suggestions, then provide `new-title`, `author`, `image-url`, or any combination. Omitted fields keep their current values. Title changes preserve the book's ID, ratings, reviews, and rating timestamps.

Example: `/update-book title:The Cipher author:Kathe Koja image-url:https://example.com/cover.jpg`

Rename example: `/update-book title:The Cipher new-title:The Cipher (1991)`

Ratings and reviews reference each book's MongoDB `bookId`. The `title` suggestions display book names and submit stable IDs; an unambiguous manually entered title still works. Correcting book metadata keeps the same review relationship.

Book polls stop accepting votes at their scheduled deadline. Ranked ballots count only when all three picks are valid and distinct; partial or duplicate ballots can be corrected before voting ends and contribute no points until complete. Final announcements show only counted votes. Voting controls identify nominations by ID, so removing a book cannot redirect an old selection to another book. Replacing a nominated book clears its previous votes. Existing saved votes remain compatible, and outdated voting controls ask members to choose again.

Winner announcements show the winning book and the runner-up with their final scores. All books tied for second place are listed as runners-up; only the winner is added to the club list. Each message shows at most four voters and keeps each ballot complete. Long ballots use smaller groups, the embed description, or a text attachment when needed. Tie announcements also preserve the full counted vote list in continuation messages. Only the first message mentions `@everyone`.

For an existing database, build the code and run `npm run migrate-rating-book-ids -- --dry-run` against a saved baseline under `.local/review-baselines/`. Stop `book-bot` before running `npm run migrate-rating-book-ids -- --apply`, then follow `SKILL.md` to restart it. The migration adds only `bookId`, preserves every original record and field, verifies the saved baseline, and creates a unique index for each server/book/member. Use `npm run migrate-rating-book-ids -- --verify` to compare again. The default mode is a dry run; ambiguous matches or changed baseline records block migration. Reports and before/after snapshots stay local and are excluded from Git.
