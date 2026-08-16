# Roadmap

Ideas discussed but intentionally deferred — not being worked on yet.

## Notion sync for Notes tab

Pull a Notion page's content into the Notes tab as a read-only mirror ("Sync from Notion" button), refreshed on demand or on load.

- One-way (Notion → Draft Day) only. True two-way sync isn't worth it: Notion docs are structured blocks (headings, nested lists, databases) vs. the Notes tab's plain textarea, so bidirectional editing would need real conflict resolution for little benefit.
- Needs a Notion internal integration token (secret, added to Vercel like `ANTHROPIC_API_KEY`) and the user sharing their Fantasy notes page with that integration.
