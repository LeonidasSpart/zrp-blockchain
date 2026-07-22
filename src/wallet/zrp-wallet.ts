"use strict";
/**
 * ZRP WALLET / LEDGER
 *
 * Important shift from the old in-memory demo: this class is the
 * server-side ACCOUNT LEDGER. It never holds a private key. Keys are
 * generated client-side (or once, at devnet-creation time, and handed
 * back to the caller — never persisted). The ledger only ever sees
 * public keys, addresses, and balances, backed by SQLite so restarts
 * don't wipe the chain.
 */

import { ZRPDatabase, AccountRow } from "../db/database";
import { generateKeyPair, generateRandomKeyPair, ZRPKeyPair } from "../crypto/keys";

export interface ZRPAccount {
    address: string;
    publicKey: string;
    balance: number;
    staked: number;
    nonce: number;
    isValidator: boolean;
    validatorStake: number;
    createdAt: number;
}

function rowToAccount(row: AccountRow): ZRPAccount {
    return {
        address: row.address,
        publicKey: row.public_key,
        balance: row.balance,
        staked: row.staked,
        nonce: row.nonce,
        isValidator: !!row.is_validator,
        validatorStake: row.validator_stake,
        createdAt: row.created_at
    };
}

export class ZRPWallet {
    private db: ZRPDatabase;
    private masterSeed: string;
    private nextIndex: number = 0;

    constructor(db: ZRPDatabase, seed?: string) {
        this.db = db;
        this.masterSeed = seed || (db.getMeta("master_seed") ?? "");
        if (!this.masterSeed) {
            throw new Error("ZRPWallet requires a master seed on first run");
        }
        const storedIndex = this.db.getMeta("next_account_index");
        this.nextIndex = storedIndex ? parseInt(storedIndex, 10) : 0;
    }

    /**
     * Deterministically derive the next devnet account (genesis/treasury use).
     * Returns the private key ONCE — the caller must save it, the ledger doesn't.
     */
    generateAccount(): ZRPKeyPair {
        const keys = generateKeyPair(this.masterSeed, this.nextIndex);
        this.nextIndex++;
        this.db.setMeta("next_account_index", this.nextIndex.toString());
        this.persistNewAccount(keys);
        return keys;
    }

    /** Register a wallet created client-side — we only ever see the public key. */
    registerAccount(publicKeyHex: string, address: string) {
        const existing = this.db.getAccount(address);
        if (existing) return rowToAccount(existing);

        const row: AccountRow = {
            address,
            public_key: publicKeyHex,
            balance: 0,
            staked: 0,
            nonce: 0,
            is_validator: 0,
            validator_stake: 0,
            created_at: Date.now()
        };
        this.db.upsertAccount(row);
        return rowToAccount(row);
    }

    private persistNewAccount(keys: ZRPKeyPair) {
        const row: AccountRow = {
            address: keys.address,
            public_key: keys.publicKey,
            balance: 0,
            staked: 0,
            nonce: 0,
            is_validator: 0,
            validator_stake: 0,
            created_at: Date.now()
        };
        this.db.upsertAccount(row);
    }

    getAccount(address: string): ZRPAccount | undefined {
        const row = this.db.getAccount(address);
        return row ? rowToAccount(row) : undefined;
    }

    /** Balance-safe transfer with nonce check, atomic at the DB level. */
    transfer(from: string, to: string, amount: number, nonce: number): boolean {
        return this.db.transferBalance(from, to, amount, nonce);
    }

    stake(address: string, amount: number): boolean {
        const acc = this.db.getAccount(address);
        if (!acc || acc.balance < amount || amount < 1) return false;

        acc.balance -= amount;
        acc.staked += amount;
        acc.validator_stake += amount;
        acc.is_validator = 1;
        acc.nonce++;
        this.db.upsertAccount(acc);
        return true;
    }

    unstake(address: string, amount: number): boolean {
        const acc = this.db.getAccount(address);
        if (!acc || acc.staked < amount) return false;

        acc.staked -= amount;
        acc.validator_stake -= amount;
        if (acc.validator_stake < 1) acc.is_validator = 0;
        acc.balance += amount;
        acc.nonce++;
        this.db.upsertAccount(acc);
        return true;
    }

    /** Devnet-only faucet — credits an address with test ZRP. Never expose on mainnet. */
    airdrop(address: string, amount: number) {
        const acc = this.db.getAccount(address);
        if (!acc) return false;
        acc.balance += amount;
        this.db.upsertAccount(acc);
        return true;
    }

    getAllAccounts(): ZRPAccount[] {
        return this.db.getAllAccounts().map(rowToAccount);
    }

    getStats() {
        const accounts = this.getAllAccounts();
        return {
            totalAccounts: accounts.length,
            totalBalance: accounts.reduce((a, b) => a + b.balance, 0),
            totalStaked: accounts.reduce((a, b) => a + b.staked, 0),
            validators: accounts.filter(a => a.isValidator).length
        };
    }
}

export function createRandomDevnetKeyPair(): ZRPKeyPair {
    return generateRandomKeyPair();
}
