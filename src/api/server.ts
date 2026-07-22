"use strict";
/**
 * ZRP DEVNET RPC API
 *
 * This is the boundary your wallet extension talks to. Every write
 * endpoint that moves balance requires a real Ed25519 signature —
 * nothing is trusted just because the caller claims an address.
 */

import express, { Request, Response } from "express";
import cors from "cors";
import { ZRPWallet } from "../wallet/zrp-wallet";
import { ZRPShardRouter, Transaction } from "../core/shard-router";
import { ZRPDatabase } from "../db/database";
import { addressFromPublicKey, txSigningPayload, verifyPayload, generateRandomKeyPair } from "../crypto/keys";
import { randomBytes } from "crypto";

export interface ApiDeps {
    db: ZRPDatabase;
    wallet: ZRPWallet;
    shardRouter: ZRPShardRouter;
    getChainStatus: () => any;
    isFaucetEnabled: boolean;
}

export function createApiServer(deps: ApiDeps) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // ── Health / status ──────────────────────────────
    app.get("/health", (_req: Request, res: Response) => {
        res.json({ ok: true });
    });

    app.get("/status", (_req: Request, res: Response) => {
        res.json(deps.getChainStatus());
    });

    // ── Accounts ──────────────────────────────────────
    app.get("/account/:address", (req: Request, res: Response) => {
        const acc = deps.wallet.getAccount(req.params.address);
        if (!acc) return res.status(404).json({ error: "account_not_found" });
        res.json(acc);
    });

    app.get("/account/:address/transactions", (req: Request, res: Response) => {
        const txs = deps.db.getTransactionsForAddress(req.params.address);
        res.json({ transactions: txs });
    });

    // Register a client-generated wallet — the server only ever receives
    // the public key. Private keys never touch this API.
    app.post("/account/register", (req: Request, res: Response) => {
        const { publicKey } = req.body;
        if (!publicKey || typeof publicKey !== "string") {
            return res.status(400).json({ error: "publicKey_required" });
        }
        const address = addressFromPublicKey(publicKey);
        const account = deps.wallet.registerAccount(publicKey, address);
        res.json(account);
    });

    // ── Devnet faucet (disabled unless explicitly enabled) ─────────────
    app.post("/faucet", (req: Request, res: Response) => {
        if (!deps.isFaucetEnabled) {
            return res.status(403).json({ error: "faucet_disabled" });
        }
        const { address, amount } = req.body;
        if (!address || !amount || amount <= 0 || amount > 1000) {
            return res.status(400).json({ error: "invalid_request", note: "amount must be 1-1000 on devnet" });
        }
        const ok = deps.wallet.airdrop(address, amount);
        if (!ok) return res.status(404).json({ error: "account_not_found_register_first" });
        res.json(deps.wallet.getAccount(address));
    });

    // Convenience for local testing only: generates a fresh keypair,
    // registers it, and returns the private key ONCE. Real wallets
    // (your extension) generate keys client-side and never send them here.
    app.post("/devnet/new-wallet", (_req: Request, res: Response) => {
        if (!deps.isFaucetEnabled) {
            return res.status(403).json({ error: "disabled_outside_devnet" });
        }
        const keys = generateRandomKeyPair();
        const account = deps.wallet.registerAccount(keys.publicKey, keys.address);
        res.json({
            ...keys,
            warning: "Private key returned once and not stored server-side. Save it now.",
            account
        });
    });

    // ── Transactions ──────────────────────────────────
    // Body: { from, to, amount, nonce, type, publicKey, signature }
    // signature must be over txSigningPayload(...) using the sender's key.
    app.post("/tx", (req: Request, res: Response) => {
        const { from, to, amount, nonce, type, publicKey, signature } = req.body;

        if (!from || !to || amount === undefined || nonce === undefined || !publicKey || !signature) {
            return res.status(400).json({ error: "missing_fields" });
        }

        const expectedAddress = addressFromPublicKey(publicKey);
        if (expectedAddress !== from) {
            return res.status(400).json({ error: "public_key_does_not_match_from_address" });
        }

        const sender = deps.wallet.getAccount(from);
        if (!sender) return res.status(404).json({ error: "sender_not_found" });
        if (sender.publicKey !== publicKey) return res.status(400).json({ error: "public_key_mismatch" });
        if (nonce !== sender.nonce) {
            return res.status(409).json({ error: "bad_nonce", expected: sender.nonce });
        }
        if (amount <= 0 || sender.balance < amount) {
            return res.status(400).json({ error: "insufficient_balance" });
        }

        const id = "tx_" + randomBytes(8).toString("hex");
        const timestamp = Date.now();
        const txType = type || "transfer";

        const payload = txSigningPayload({ id, from, to, amount, type: txType, nonce, timestamp });
        const validSig = verifyPayload(payload, signature, publicKey);
        if (!validSig) {
            return res.status(401).json({ error: "invalid_signature" });
        }

        const tx: Transaction = { id, from, to, amount, type: txType, nonce, signature, publicKey, timestamp };
        deps.shardRouter.addTransaction(tx);

        res.status(202).json({ accepted: true, txId: id, note: "queued — will land in the next block" });
    });

    app.get("/tx/:id", (req: Request, res: Response) => {
        const tx = deps.db.getTransaction(req.params.id);
        if (!tx) return res.status(404).json({ error: "not_found" });
        res.json(tx);
    });

    // ── Blocks ────────────────────────────────────────
    app.get("/block/:slot", (req: Request, res: Response) => {
        const slot = parseInt(req.params.slot, 10);
        const block = deps.db.getBlock(slot);
        if (!block) return res.status(404).json({ error: "not_found" });
        res.json(block);
    });

    app.get("/blocks/latest", (req: Request, res: Response) => {
        const limit = Math.min(parseInt(String(req.query.limit || "20"), 10), 100);
        res.json({ blocks: deps.db.getLatestBlocks(limit) });
    });

    return app;
}
