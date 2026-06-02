---
name: cross-kind channel dedupe hazard
description: Why entity dedupe-by-channel in the worker must be kind-scoped, not via the shared findEntityByChannel.
---

# Channel-based dedupe must be kind-scoped

The shared `entities/channels.findEntityByChannel` resolves an entity by a
channel (email / linkedin / twitter / phone) but does **NOT** filter by
`u_entities.kind`. Email and LinkedIn channels are not unique across kinds —
an org/fund row can legitimately own `info@acme.com` while a person row owns a
personal address, and the same LinkedIn company-vs-personal URL collisions
happen too.

**Why:** during the person/contact CSV import, using `findEntityByChannel`
directly let a *person* row dedupe onto an existing *org* entity sharing the
channel, then write person facts (name/title/employer) and backfill primary
keys onto the org — silent cross-kind data corruption.

**How to apply:** when deduping within a single kind (person import, firm
import), do the channel lookup with an explicit `JOIN u_entities e ... WHERE
e.kind = '<kind>'` filter (and `e.status NOT IN ('merged','soft_deleted')`),
not the shared helper. The shared helper is only safe when the caller truly
doesn't care which kind it lands on.
