# Shared Spaces

Shared Cars keeps one car's mileage history in a shared space on the worker (`/spaces/v1`): the people on the car create it, invite each other through Buddies, join, put and sync sealed records, and watch a live socket for changes. The owner removes people, rekeys, and stops sharing. Every call takes an account session's bearer token; the server holds only ciphertext, member token hashes, members' X25519 public keys, and wrapped keys.

## Sub-features

- `create` makes a space at epoch 1 (`{"ok":true,"seq":1,"joinedAt":…}`); `memberId` must match `dhPub` (400 `bad_request`); an identical retry on an unchanged space gets the same answer (and doesn't count against the 20 a rolling day per account); any other reused id is 409 `conflict`, a deleted one 410 `gone`.
- `invite-join` opens an invite at the current epoch (`invite/create` with `epoch`, else 409 `stale_key`), joins with the secret and the invitation's `epoch` (`join`, `{ok,seq,epoch,joinedAt}`; a fresh join at another epoch is 409 `stale_key`; a retry, at any epoch, gets the current epoch and its original `joinedAt`), burns an invite after 5 wrong secrets, and caps members plus open invites at 10 (KV `spaces:maxMembers`). A member's open invites close when they leave; every open invite closes when anyone is removed, so the removed member can't rejoin through anyone's. A closed, used, or burned invite's id is 409 `conflict` on `invite/create` until it would have expired (an identical retry is `ok` only while it's open). `invite/delete` of a used or closed invite is `ok` for any member; an open one is its inviter's or the owner's to close.
- `put-sync` stores records by newest stamp (a deletion wins a tie, then the lower blob hash), refuses someone else's `m.<memberId>` and a non-owner's `k.<x>` with 403 `forbidden` (the whole put, costing no put budget), refuses a stale epoch with 409 `stale_key`, caps a space at 50,000 records and 256 MiB of decoded blobs (429 `limit`), takes 60 puts a rolling minute per member (kept across eviction), and pages `sync` with `limit` and `more` (a page also stops at about 4 MiB of blobs). `sync`'s `members` carry `dhPub`.
- `roles` passes ownership to the earliest member when the owner leaves, deletes the space when the last member leaves, and keeps `member/remove`, `rekey`, and `delete` owner only. A `rekey` whose wraps miss a member (or are empty) or name a non-member is 409 `conflict`. Its required `link: {stamp, blob}` is stored as record `k.<epoch>` at the new epoch, replacing any planted version, and the answer's `seq` is the link's (the rekey's + 1).
- `gone-forbidden` answers 410 `gone` for a member who isn't on the space and 403 `forbidden` for a wrong member token.
- `live` takes `x-ww-space-auth` (`b64u(JSON { spaceId, memberId })`) and `x-ww-space-token` (`b64u(token)`); says `{"type":"hello","seq":N}`, then `changed`; answers `ping` with `pong`; closes with `4001 "gone"` on removal, leave, or delete and `4002 "replaced"` past 4 sockets per member the cap allows (40 at 10): the opener's own oldest while they hold 4 or more, else the oldest of whoever holds the most, until the space is at the cap. The Worker hands the DO `x-ww-space-member-token`.
- `kill-switch` answers 503 `disabled` with `Retry-After: 60` while KV `spaces:enabled` is `false`, except `leave`, `member/remove`, and `delete`.

## How to get to it (user POV)

- Mileage → a car → Share starts a space and invites a buddy; the buddy's bell entry offers Join.
- Opening Mileage, pulling to refresh, and any `car.*` Buddies event sync the shared cars; the foreground app keeps one live socket per shared car.
- A shared car's people list offers Remove (owner), Leave, and Stop Sharing (owner).

## Driving it with verify-ww-api

Preconditions:

- `node scripts/verify/dev.mjs doctor` passes, including `account sessions enabled` and `shared spaces enabled`.

- **Whole flow.** Run `pnpm test:e2e src/e2e/spaces.e2e.test.ts`. Three accounts create (and retry), invite, join (and retry), put, sync, remove one (their socket closes 4001, and neither their own open invite nor another member's lets them back: 404 `not_found`), rekey to epoch 2 with its link (wraps still naming the removed member get `conflict`, no `link` is 400; a member's `k.2` is 403 `forbidden`, and the link replaces the owner's earlier `k.2`; old-epoch puts and invites get `stale_key`), and leave until the space is `gone`. Another space checks reserved ids (someone else's `m.`, a non-owner's `k.`, a mixed batch, a deletion: 403 `forbidden`, nothing stored), a join at another epoch (409 `stale_key`), a retried join after a rekey (the current epoch, the original `joinedAt`), and a closed invite's id (409 `conflict` on `invite/create`, 404 on `join`). Two more fill a space with 240 records of 16 KiB, sync a page cut by its 4 MiB budget, then `delete`, or leave as the last member: both 200 (real SQLite: an unfinished cursor would make them 500 `SQLITE_LOCKED`). Then the kill switch in the local KV. Vitest reports 7 tests passed, and `.verify/artifacts/e2e-spaces-*.json` holds the exchanges.
- **Switch on.** Run `curl -s -X POST $URL/spaces/v1/sync -H 'content-type: application/json' -H "cf-connecting-ip: 198.18.5.1" -d '{}'`. The body is `{"ok":false,"error":"unauthorized","code":"unauthorized"}`; `disabled` means KV `spaces:enabled` isn't `true` (`node scripts/verify/dev.mjs kv delete spaces:enabled`).
- **Member cap.** Run `node scripts/verify/dev.mjs kv put spaces:maxMembers 2`, then a new space's second `invite/create` is 429 `limit` with no `Retry-After` (the owner plus one open invite fill it). Restore it with `node scripts/verify/dev.mjs kv delete spaces:maxMembers`.

## Gotchas

- Every op needs a bearer token from a dev-bypass session (`openSession()` in `src/test/e2e.ts`); the space never sees which session calls, so any of a person's sessions work.
- The member `token` is 32 random bytes (43 b64u characters) and `tokenHash` is `b64u(SHA-256(token bytes))`, not of the string.
- `memberId` is `b64u(SHA-256("ww-spaces/v1/member-id|" + spaceId + "|" + dhPub)[0..16])`, `dhPub` as its b64u text (`spaceMemberId()` in `src/test/buddiesClient.ts`). Random 32 bytes stand in for a real X25519 key; the server only checks the commitment.
- Restore `spaces:enabled` and `spaces:maxMembers` (`kv delete`) after flipping them.
- The unit tests' SQLite fake (`src/test/durableObjects.ts`) reads every cursor whole up front, so a cursor left unfinished only fails on real workerd. Prove anything that stops reading rows early here, with e2e. On `wrangler dev`, an unfinished cursor makes `DROP TABLE` fail with `SQLITE_LOCKED`, but not `deleteAll()`.
- Under `wrangler dev`, the TCP connection lingers about 10 s after a server-sent close frame; the frame itself (4001, 4002) arrives at once.
