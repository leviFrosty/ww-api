# Buddies relay

Buddies lets two publishers share upcoming Plans through a blind relay. Each person owns an inbox signed with their Ed25519 key. A buddy writes cards and events into the other inbox through a per-pair writer key. Pairing runs invite → fetch → claim → confirm, and `inbox/sync` reads everything back. The wire contract is in `docs/buddies-protocol.md`.

## Sub-features

- `register` makes `inbox/register` idempotent per key and returns `conflict` for a different key.
- `device` makes `device/register` upsert a device and its push templates. Pushes are skipped locally because there are no APNs keys.
- `invite` runs `invite/create` → `invite/fetch` (`status:"open"`) → `invite/claim` → `invite/fetch` (`status:"claimed"`) → `invite/delete` → `invite/fetch` (404).
- `claim-event` appends an `invite.claimed` event (`slotId:""`, `eventId` = inviteId, the claim blob) to the creator's inbox.
- `writes` covers `card/put` and `event/put` through a writer slot. `event/put` is deduped by `eventId` and returns the original `seq`.
- `sync` makes `inbox/sync(since)` return slots plus cards, events, and roster with `seq > since`. `roster` is `null` when unchanged.
- `auth` rejects a foreign key with 401 `bad_signature`, a reused nonce with 409 `replay`, a `ts` outside ±5 min with 401 `stale`, and an unknown slot with 410 `gone`.
- `limits` caps open invites at 3, slots plus invites at 5, and unsigned ops at 30/min per IP. Five wrong claim secrets burn an invite.
- `leave` removes the slot, its card, and its events from both inboxes through `slot/remove` and `slot/leave`.
- `delete` wipes the inbox with `inbox/delete`. Sync then returns 404 `not_found`.
- `kill-switch` makes every op return 503 `disabled` when KV `buddies:enabled` is `false`, except `inbox/delete`, `slot/remove`, and `slot/leave`.

## How to get to it (user POV)

- In the app: Buddies → Invite a buddy creates an invite and shares `https://ww-proxy.leviwilkerson.com/b#1<secret>`.
- The buddy taps the link. The app opens, fetches and claims the invite, and the inviter confirms.
- Opening the Buddies tab or the calendar syncs the inbox, and editing Plans writes a card. Removing a buddy runs leave. Deleting Buddies data deletes the inbox.

## Driving it with verify-ww-api

Preconditions:

- `doctor` passes, including `ok    buddies relay enabled`.
- `.verify/state.json` exists, so the e2e helpers resolve the URL.

- **Pair two people.** Run `pnpm test:e2e src/e2e/buddies.e2e.test.ts -t "pairing happy path"`. This registers Levi and Maria, creates, fetches, and claims an invite, confirms, and exchanges cards, a roster, leave, and delete. It passes with a read-back after every write.
- **Unsigned probe.** Fetch an unknown invite. Run `curl -s -X POST $URL/buddies/v1/invite/fetch -H "cf-connecting-ip: 198.18.3.1" -d "{\"p\":\"$(printf '{"inviteId":"AAAAAAAAAAAAAAAAAAAAAA"}' | base64 | tr '+/' '-_' | tr -d '=')\"}"`. The body is `{"error":"not_found"}` with status 404.
- **Malformed envelope.** Run `curl -s -X POST $URL/buddies/v1/inbox/sync -H "cf-connecting-ip: 198.18.3.2" -d '{"p":"!!"}'`. The body is `{"error":"bad_request"}` with status 400.
- **Limits and abuse.** Run `pnpm test:e2e src/e2e/buddies.e2e.test.ts -t "relay limits"`. The 31st `invite/fetch` from one IP gets 429, the 4th open invite gets 429, and unknown ops get 404.
- **Kill switch.** Run `pnpm test:e2e src/e2e/buddies.e2e.test.ts -t "kill switch"`. `inbox/register` and `inbox/sync` return 503 `disabled`, `inbox/delete` still returns `{"ok":true}`, and the switch is restored afterwards.
- **Fuzz.** Run `pnpm fuzz:buddies --runs 300`. The last lines read `fuzz: canary intact, health after ok` and `fuzz: ok`.
- **Proof.** Keep `.verify/artifacts/e2e-buddies-*.json` (every envelope and response) and `.verify/artifacts/fuzz-*.json`, which must have `failures: []` and `canary.intact: true`.

## Gotchas

- Signed payloads need `ts` within ±5 min of the worker clock and a fresh 22-char `nonce`. Resending a captured envelope is a replay, so build a new one per attempt.
- Unknown inbox ids return 404 before the signature check, so a "wrong key" test needs a registered inbox to prove 401.
- Each slot allows 60 `card/put` and `event/put` writes per hour, and each inbox allows 20 invite creations per day. Long manual sessions on one identity hit `rate_limited` (429), so use fresh identities.
- Under `wrangler dev` only, the request after a cancelled chunked upload gets a canned proxy 503 (or hangs, for a GET). The fuzzer drains and retries it and counts it as `devProxyRetries`; it is not a worker bug.
- The kill-switch test edits shared local KV. Don't run e2e and the fuzzer at the same time.
