# Book-Bot
Bot for my friends to use to view, store, nominate our books

Use `/update-book` to change an existing book's author or cover image. Choose the book from the `title` suggestions, then provide `author`, `image-url`, or both. Omitted fields keep their current values; the title stays unchanged.

Example: `/update-book title:The Cipher author:Kathe Koja image-url:https://example.com/cover.jpg`

Ratings and reviews reference each book's MongoDB `bookId`. The `title` suggestions display book names and submit stable IDs; an unambiguous manually entered title still works. Correcting book metadata keeps the same review relationship.

For an existing database, build the code and run `npm run migrate-rating-book-ids -- --dry-run` against a saved baseline under `.local/review-baselines/`. Stop `book-bot` before running `npm run migrate-rating-book-ids -- --apply`, then follow `SKILL.md` to restart it. The migration adds only `bookId`, preserves every original record and field, verifies the saved baseline, and creates a unique index for each server/book/member. Use `npm run migrate-rating-book-ids -- --verify` to compare again. The default mode is a dry run; ambiguous matches or changed baseline records block migration. Reports and before/after snapshots stay local and are excluded from Git.
