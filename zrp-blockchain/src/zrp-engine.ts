"use strict";
/**
 * ZRP MAIN ENGINE — devnet orchestrator
 *
 * Wires together: persistent DB, PoH, Shard Router, Tower BFT, PoUW/minting,
 * the wallet/ledger, and the RPC API. Unlike the original demo, state
 * survives restarts — on boot it loads the existing chain from SQLite
 * instead of re-running genesis every time.
 */

import { createHash, randomBytes } from "crypto";
import { ZRPDatabase } from "./db/database";
import { ZRPNode } from "./core/node-daemon";
import { ZRPPoH } from "./core/poh-engine";
import { ZRPShardRouter, Transaction } from "./core/shard-router";
import { ZRPTowerBFT, Block } from "./core/tower-bft";
import { ZRPWallet } from "./wallet/zrp-wallet";
import { createApiServer } from "./api/server";
import { generateKeyPair, txSigningPayload, signPayload, ZRPKeyPair } from "./crypto/keys";

export class ZRPEngine {
    public poh: ZRPPoH;
    public shardRouter: ZRPShardRouter;
    public consensus: ZRPTowerBFT;
    public wallet: ZRPWallet;
    public node: ZRPNode;
    public db: ZRPDatabase;

    private isRunning: boolean = false;
    private blockInterval: any;
    private txInterval: any;
    private minerAddress: string;

    // In-memory only, for the devnet demo-traffic generator. Never persisted,
    // never exposed over the API. A real client wallet holds its own keys —
    // this is purely so `npm start` has something to show in the explorer.
    private demoKeypairs: ZRPKeyPair[] = [];
    private demoTrafficEnabled: boolean;

    constructor(dbPath?: string) {
        console.log("ZRP DEVNET — Zero Resistance Protocol (persistent)\n");

        this.db = new ZRPDatabase(dbPath);
        this.demoTrafficEnabled = process.env.ZRP_DEMO_TRAFFIC !== "off";

        const isFirstRun = !this.db.getMeta("master_seed");
        if (isFirstRun) {
            this.db.setMeta("master_seed", randomBytes(32).toString("hex"));
            this.db.setMeta("next_account_index", "0");
        }

        this.wallet = new ZRPWallet(this.db);

        const resumeIndex = parseInt(this.db.getMeta("poh_index") || "0", 10);
        const resumeHash = this.db.getMeta("poh_hash");
        this.poh = new ZRPPoH("ZRP_GENESIS_2026_07_21", resumeIndex, resumeHash);

        this.shardRouter = new ZRPShardRouter();
        this.consensus = new ZRPTowerBFT();
        this.consensus.setCurrentSlot(parseInt(this.db.getMeta("current_slot") || "0", 10));

        this.minerAddress = this.db.getMeta("miner_address") || "";
        this.node = null as any; // set in initialize() once we have a miner address

        this.setupEventListeners();

        if (isFirstRun) {
            this.runGenesis();
        } else {
            this.resumeFromState();
        }

        this.node = new ZRPNode(this.minerAddress);
        this.node.onRewardMinted((reward, addr) => {
            this.wallet.airdrop(addr, reward.miner);
            this.db.setMeta("total_minted", this.node.minting.getMintingStats().totalMinted.toString());
        });
    }

    private setupEventListeners() {
        this.shardRouter.on("block_executed", (data: any) => {
            console.log(`Block executed — lanes:${data.lanes} txs:${data.totalTxs} time:${data.totalTime}ms tps:${data.tps}`);
        });

        this.consensus.on("block_finalized", (data: any) => {
            console.log(`Block ${data.slot} FINALIZED in ${data.finalityTime}ms (${data.voteRatio})`);
            this.db.updateBlockStatus(data.slot, "finalized", Date.now());
        });

        this.consensus.on("validator_slashed", (data: any) => {
            console.log(`Validator ${data.address.slice(0, 12)}... SLASHED: ${data.reason} (-${data.slashAmount.toFixed(2)} ZRP)`);
        });
    }

    /** First-ever boot: create genesis accounts and validators, persist them. */
    private runGenesis() {
        const genesisAccounts = [
            { name: "ZRP Treasury", balance: 500_000 },
            { name: "Science Fund", balance: 300_000 },
            { name: "Dev Team", balance: 150_000 },
            { name: "Community", balance: 50_000 }
        ];

        for (const acc of genesisAccounts) {
            const keys = this.wallet.generateAccount();
            this.wallet.airdrop(keys.address, acc.balance);
            this.demoKeypairs.push(keys);
            console.log(`${acc.name}: ${keys.address} | ${acc.balance.toLocaleString()} ZRP`);
        }

        // A couple of extra funded accounts purely to give the demo traffic
        // generator something to shuffle balances between.
        for (let i = 0; i < 3; i++) {
            const keys = this.wallet.generateAccount();
            this.wallet.airdrop(keys.address, 10_000);
            this.demoKeypairs.push(keys);
        }

        const validators = this.demoKeypairs.slice(0, 5);
        for (const v of validators) {
            this.wallet.stake(v.address, 10_000);
            this.consensus.registerValidator(v.address, 10_000, "Z10", 50 + Math.random() * 100);
        }

        this.minerAddress = this.demoKeypairs[0].address;
        this.db.setMeta("miner_address", this.minerAddress);
        this.db.setMeta("total_minted", "1000000");

        console.log(`\nGenesis initialized: ${this.wallet.getAllAccounts().length} accounts, ${validators.length} validators`);
        console.log(`Total supply: ${this.wallet.getStats().totalBalance.toLocaleString()} ZRP\n`);
    }

    /** Every subsequent boot: re-register existing validators from the DB, no new coins minted. */
    private resumeFromState() {
        const accounts = this.wallet.getAllAccounts();
        const validators = accounts.filter(a => a.isValidator);

        for (const v of validators) {
            this.consensus.registerValidator(v.address, v.validatorStake, "Z10", 50 + Math.random() * 100);
        }

        if (!this.minerAddress && accounts.length > 0) {
            this.minerAddress = accounts[0].address;
            this.db.setMeta("miner_address", this.minerAddress);
        }

        console.log(`Resumed existing chain — ${accounts.length} accounts, ${validators.length} validators, slot ${this.db.getMeta("current_slot") || 0}\n`);
    }

    /**
     * Build and sign a real transaction using an in-memory demo keypair.
     * This exercises the exact same signature-verification path the API
     * uses for external callers — it's not a shortcut.
     */
    private generateSignedDemoTx(): Transaction | null {
        if (this.demoKeypairs.length < 2) return null;

        const fromKeys = this.demoKeypairs[Math.floor(Math.random() * this.demoKeypairs.length)];
        const toKeys = this.demoKeypairs[Math.floor(Math.random() * this.demoKeypairs.length)];
        if (fromKeys.address === toKeys.address) return null;

        const fromAccount = this.wallet.getAccount(fromKeys.address);
        if (!fromAccount) return null;

        const amount = Math.floor(Math.random() * 50) + 1;
        if (fromAccount.balance < amount) return null;

        const id = "tx_" + randomBytes(8).toString("hex");
        const timestamp = Date.now();
        const nonce = fromAccount.nonce;

        const payload = txSigningPayload({ id, from: fromKeys.address, to: toKeys.address, amount, type: "transfer", nonce, timestamp });
        const signature = signPayload(payload, fromKeys.privateKey);

        return {
            id,
            from: fromKeys.address,
            to: toKeys.address,
            amount,
            type: "transfer",
            nonce,
            signature,
            publicKey: fromKeys.publicKey,
            timestamp
        };
    }

    async start(apiPort: number = 8899) {
        this.isRunning = true;

        this.poh.start();
        await this.node.start();

        if (this.demoTrafficEnabled) {
            this.txInterval = setInterval(() => {
                if (!this.isRunning) return;
                const txCount = Math.floor(Math.random() * 5) + 1;
                for (let i = 0; i < txCount; i++) {
                    const tx = this.generateSignedDemoTx();
                    if (tx) this.shardRouter.addTransaction(tx);
                }
            }, 500);
        }

        this.blockInterval = setInterval(async () => {
            if (!this.isRunning) return;
            await this.produceBlock();
        }, 2000);

        setInterval(() => {
            if (!this.isRunning) return;
            this.printStats();
        }, 5000);

        const app = createApiServer({
            db: this.db,
            wallet: this.wallet,
            shardRouter: this.shardRouter,
            getChainStatus: () => this.getFullStats(),
            isFaucetEnabled: process.env.ZRP_FAUCET !== "off"
        });
        app.listen(apiPort, () => {
            console.log(`\nZRP RPC API listening on :${apiPort}\n`);
        });

        console.log("ZRP devnet running.\n");
    }

    /** Executes pending txs, applies real balance transfers, proposes + votes a block, persists it. */
    private async produceBlock() {
        this.poh.setCurrentLoad(this.shardRouter.getStats().totalPending);
        const shardResult = await this.shardRouter.executeBlock();

        // Apply real, atomic balance transfers for every executed tx —
        // this is the part the original demo never actually did; it just
        // mutated in-memory numbers separately from "executing" the block.
        const allTxs: Transaction[] = shardResult.laneResults.flatMap((l: any) => l.transactions || []);
        for (const tx of allTxs) {
            this.wallet.transfer(tx.from, tx.to, tx.amount, tx.nonce);
        }

        const pohEntry = this.poh.tick(allTxs.length);
        this.db.setMeta("poh_index", pohEntry.index.toString());
        this.db.setMeta("poh_hash", pohEntry.hash);

        const block = this.consensus.proposeBlock(
            pohEntry.hash,
            shardResult.laneResults.flatMap((l: any) => l.results),
            "state_root_" + pohEntry.hash.slice(0, 16)
        );
        this.db.setMeta("current_slot", block.slot.toString());

        this.db.insertBlock({
            slot: block.slot,
            poh_hash: block.pohHash,
            state_root: block.stateRoot,
            tx_count: allTxs.length,
            confirmation_status: "pending",
            finalized_at: null,
            created_at: block.proposedAt
        });

        for (const tx of allTxs) {
            this.db.insertTransaction({
                id: tx.id,
                block_slot: block.slot,
                from_address: tx.from,
                to_address: tx.to,
                amount: tx.amount,
                type: tx.type,
                nonce: tx.nonce,
                signature: tx.signature,
                timestamp: tx.timestamp
            });
        }

        await this.consensus.simulateNetworkVote(block.slot);
    }

    private printStats() {
        const stats = this.getFullStats();
        console.log(
            `[stats] slot=${stats.consensus.currentSlot} finalized=${stats.consensus.finalizedBlocks} ` +
            `pending_tx=${stats.shard.totalPending} accounts=${stats.wallet.totalAccounts} ` +
            `minted=${stats.minting.totalMinted.toFixed(0)}/${stats.minting.maxSupply.toLocaleString()}`
        );
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.blockInterval);
        clearInterval(this.txInterval);
        this.poh.stop();
        this.node.stop();
        this.db.close();
        console.log("\nZRP engine stopped, DB closed cleanly.");
    }

    getFullStats() {
        return {
            poh: this.poh.getStats(),
            shard: this.shardRouter.getStats(),
            consensus: this.consensus.getStats(),
            wallet: this.wallet.getStats(),
            minting: this.node.minting.getMintingStats(),
            workQueue: this.node.router.getQueueStats()
        };
    }
}
