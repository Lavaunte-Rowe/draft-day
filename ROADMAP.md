# Roadmap

Ideas discussed but intentionally deferred — not being worked on yet.

## Notion sync for Notes tab

Pull a Notion page's content into the Notes tab as a read-only mirror ("Sync from Notion" button), refreshed on demand or on load.

- One-way (Notion → Draft Day) only. True two-way sync isn't worth it: Notion docs are structured blocks (headings, nested lists, databases) vs. the Notes tab's plain textarea, so bidirectional editing would need real conflict resolution for little benefit.
- Needs a Notion internal integration token (secret, added to Vercel like `ANTHROPIC_API_KEY`) and the user sharing their Fantasy notes page with that integration.

## IR roster slot

Add an injured-reserve bench slot (the user's real Yahoo league has one, alongside the flex IDP "D" slot added this session).

- Not a quick add-on: every other slot type (`QB`/`RB`/.../`IDP`) is an eligibility rule based on a player's position. An IR slot instead needs an "injured players only, doesn't count against the active roster limit" rule — a genuinely different kind of check, not another entry in the existing position-array pattern used everywhere else (`myRoster`, `reqEditor`, needs pills, filters, etc.).
- Roughly comparable in scope to the IDP feature itself, not a small follow-up.
