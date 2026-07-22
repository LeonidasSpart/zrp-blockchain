"use strict";
/**
 * ZRP PERSISTENCE LAYER
 *
 * SQLite-backed store for accounts, blocks, and transactions.
 * Everything the in-memory demo used to lose on restart now survives it.
 *
 * File lives at ZRP_DB_PATH (default ./data/zrp.db). On Railway, mount a
 * volume at /data and set ZRP_DB_PATH=/data/zrp.db so it survives deploys.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface AccountRow {
    address: string;
    public_key: string;
    balance: number;
    staked: number;
    nonce: number;
    is_validator: number; // sqlite has no bool
    validator_stake: number;
    created_at: number;
}

export interface BlockRow {
    slot: number;
    poh_hash: string;
    state_root: string;
    tx_count: number;
    confirmation_status: string;
    finalized_at: number | null;
    created_at: number;
}

export interface TransactionRow {
    id: string;
    block_slot: number | null;
    from_address: string;
    to_address: string;
    amount: number;
    type: string;
    nonce: number;
    signature: string;
    timestamp: number;
}

export class ZRPDatabase {
    private db: Database.Database;

    constructor(dbPath?: string) {
        const resolvedPath = dbPath || process.env.ZRP_DB_PATH || "./data/zrp.db";
        const dir = path.dirname(resolvedPath);
        if (dir && dir !== "." && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }

    private migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS accounts (
                address TEXT PRIMARY KEY,
                public_key TEXT NOT NULL,
                balance REAL NOT NULL DEFAULT 0,
                staked REAL NOT NULL DEFAULT 0,
                nonce INTEGER NOT NULL DEFAULT 0,
                is_validator INTEGER NOT NULL DEFAULT 0,
                validator_stake REAL NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS blocks (
                slot INTEGER PRIMARY KEY,
                poh_hash TEXT NOT NULL,
                state_root TEXT NOT NULL,
                tx_count INTEGER NOT NULL DEFAULT 0,
                confirmation_status TEXT NOT NULL DEFAULT 'pending',
                finalized_at INTEGER,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                block_slot INTEGER,
                from_address TEXT NOT NULL,
                to_address TEXT NOT NULL,
                amount REAL NOT NULL,
                type TEXT NOT NULL,
                nonce INTEGER NOT NULL,
                signature TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (block_slot) REFERENCES blocks(slot)
            );

            CREATE TABLE IF NOT EXISTS chain_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address);
            CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address);
            CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block_slot);
        `);
    }

    // ── Accounts ──────────────────────────────────────
    upsertAccount(acc: AccountRow) {
        this.db.prepare(`
            INSERT INTO accounts (address, public_key, balance, staked, nonce, is_validator, validator_stake, created_at)
            VALUES (@address, @public_key, @balance, @staked, @nonce, @is_validator, @validator_stake, @created_at)
            ON CONFLICT(address) DO UPDATE SET
                balance = @balance,
                staked = @staked,
                nonce = @nonce,
                is_validator = @is_validator,
                validator_stake = @validator_stake
        `).run(acc);
    }

    getAccount(address: string): AccountRow | undefined {
        return this.db.prepare(`SELECT * FROM accounts WHERE address = ?`).get(address) as AccountRow | undefined;
    }

    getAllAccounts(): AccountRow[] {
        return this.db.prepare(`SELECT * FROM accounts`).all() as AccountRow[];
    }

    // ── Blocks ────────────────────────────────────────
    insertBlock(block: BlockRow) {
        this.db.prepare(`
            INSERT INTO blocks (slot, poh_hash, state_root, tx_count, confirmation_status, finalized_at, created_at)
            VALUES (@slot, @poh_hash, @state_root, @tx_count, @confirmation_status, @finalized_at, @created_at)
        `).run(block);
    }

    updateBlockStatus(slot: number, status: string, finalizedAt: number | null) {
        this.db.prepare(`
            UPDATE blocks SET confirmation_status = ?, finalized_at = ? WHERE slot = ?
        `).run(status, finalizedAt, slot);
    }

    getBlock(slot: number): BlockRow | undefined {
        return this.db.prepare(`SELECT * FROM blocks WHERE slot = ?`).get(slot) as BlockRow | undefined;
    }

    getLatestBlocks(limit: number = 20): BlockRow[] {
        return this.db.prepare(`SELECT * FROM blocks ORDER BY slot DESC LIMIT ?`).all(limit) as BlockRow[];
    }

    // ── Transactions ──────────────────────────────────
    insertTransaction(tx: TransactionRow) {
        this.db.prepare(`
            INSERT INTO transactions (id, block_slot, from_address, to_address, amount, type, nonce, signature, timestamp)
            VALUES (@id, @block_slot, @from_address, @to_address, @amount, @type, @nonce, @signature, @timestamp)
        `).run(tx);
    }

    getTransaction(id: string): TransactionRow | undefined {
        return this.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TransactionRow | undefined;
    }

    getTransactionsForAddress(address: string, limit: number = 50): TransactionRow[] {
        return this.db.prepare(`
            SELECT * FROM transactions WHERE from_address = ? OR to_address = ?
            ORDER BY timestamp DESC LIMIT ?
        `).all(address, address, limit) as TransactionRow[];
    }

    // ── Chain meta (current slot, poh index, etc.) ─────
    setMeta(key: string, value: string) {
        this.db.prepare(`
            INSERT INTO chain_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = ?
        `).run(key, value, value);
    }

    getMeta(key: string): string | undefined {
        const row = this.db.prepare(`SELECT value FROM chain_meta WHERE key = ?`).get(key) as { value: string } | undefined;
        return row?.value;
    }

    // ── Transaction-safe balance transfer ──────────────
    // Runs as a single SQLite transaction so a crash mid-transfer can't
    // debit one account without crediting the other.
    transferBalance(from: string, to: string, amount: number, newNonce: number): boolean {
        const txn = this.db.transaction((from_: string, to_: string, amount_: number, nonce_: number) => {
            const sender = this.getAccount(from_);
            const receiver = this.getAccount(to_);
            if (!sender || !receiver) throw new Error("account_not_found");
            if (sender.balance < amount_) throw new Error("insufficient_balance");
            if (nonce_ !== sender.nonce) throw new Error("bad_nonce");

            this.db.prepare(`UPDATE accounts SET balance = balance - ?, nonce = ? WHERE address = ?`)
                .run(amount_, nonce_ + 1, from_);
            this.db.prepare(`UPDATE accounts SET balance = balance + ? WHERE address = ?`)
                .run(amount_, to_);
        });

        try {
            txn(from, to, amount, newNonce);
            return true;
        } catch {
            return false;
        }
    }

    close() {
        this.db.close();
    }
}

export { ZRPDatabase };
