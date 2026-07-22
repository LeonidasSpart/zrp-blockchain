# ZRP Devnet

Phase 1 of turning the ZRP demo into a real chain: persistent state,
real Ed25519 signatures enforced on every transaction, and a JSON RPC
API for your wallet extension to talk to. Still single-node — no P2P
gossip or multi-validator consensus yet (that's phase 2).

## What changed vs. the original demo

- **Persistence.** SQLite (`better-sqlite3`) stores accounts, blocks,
  and transactions. Restarting the process resumes the chain instead
  of wiping it.
- **Real crypto.** Ed25519 via `@noble/curves` (pure JS, no native
  build step). Keys are deterministically derived from a seed, so
  accounts are actually recoverable — the old RSA path silently
  ignored the seed and generated random keys every time.
- **Enforced signatures.** `POST /tx` verifies the signature against
  the sender's public key before anything touches the ledger. No
  signature, no verify — no transaction.
- **RPC API.** Express server exposing accounts, transactions, blocks,
  and chain status — see below.
- Fixed the bugs from the code review: duplicate exports that broke
  `tsc`, the shard-router lane-remap crash, the `navigator` reference
  that doesn't exist in Node, the no-op finality-time calculation, and
  the fake `crypto` npm package dependency (Node's `crypto` is built
  in — that package name is an abandoned placeholder).

## Run it

```bash
npm install
npm run build
npm start
```

or for iteration without a build step:

```bash
npm install
npm run dev
```

Env vars (all optional):

| Var | Default | Purpose |
|---|---|---|
| `ZRP_DB_PATH` | `./data/zrp.db` | SQLite file location |
| `ZRP_API_PORT` | `8899` | RPC API port |
| `ZRP_DEMO_TRAFFIC` | on | set to `off` to stop the built-in fake-traffic generator |
| `ZRP_FAUCET` | on | set to `off` to disable `/faucet` and `/devnet/new-wallet` |

On Railway: mount a volume at `/data` and set `ZRP_DB_PATH=/data/zrp.db`
so the chain survives redeploys.

## RPC API

- `GET /status` — full chain stats
- `GET /account/:address`
- `GET /account/:address/transactions`
- `POST /account/register` `{ publicKey }` — registers a client-generated wallet
- `POST /tx` `{ from, to, amount, nonce, type, publicKey, signature }`
- `GET /tx/:id`
- `GET /block/:slot`
- `GET /blocks/latest?limit=20`
- `POST /faucet` `{ address, amount }` — devnet only
- `POST /devnet/new-wallet` — devnet only, returns a private key once for local testing

### Signing a transaction (what your extension needs to do)

```
payload = sha256(JSON.stringify({ id, from, to, amount, type, nonce, timestamp }))
signature = ed25519.sign(payload, privateKey)
```

`id` is a string you generate client-side (e.g. `tx_` + random hex),
`nonce` must equal the sender's current on-chain nonce (`GET /account/:address`).
See `src/crypto/keys.ts` (`txSigningPayload`, `signPayload`) for the
exact canonical serialization — your extension's signing code must
match it byte-for-byte or the server will reject the signature.

## Known limitations (still ahead of us)

- Single process, single validator set you control — not yet a network.
- PoUW work units aren't independently verified server-side; a miner's
  claimed proof is trusted, not checked. Fine for a devnet, not for
  anything holding real value.
- No rate limiting / auth on the RPC API — don't expose the faucet
  publicly with `ZRP_FAUCET` on.
