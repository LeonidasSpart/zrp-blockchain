"use strict";
/**
 * ZRP PROOF OF HISTORY (PoH)
 * Cryptographic timestamping — the heartbeat of ZRP
 *
 * Unlike Solana's fixed 400ms slots, ZRP uses ADAPTIVE PoH:
 * - Speed adjusts based on network load
 * - Faster during high demand, stable during low
 */

import { createHash } from "crypto";
import { EventEmitter } from "events";

export interface PoHHash {
    index: number;
    hash: string;
    timestamp: number;
    txCount: number;
    adaptiveDelay: number; // ms — ZRP unique feature
}

export class ZRPPoH extends EventEmitter {
    private hashQueue: PoHHash[] = [];
    private currentHash: string;
    private index: number = 0;
    private baseDelay: number = 50; // ms (faster than Solana's 400ms)
    private isRunning: boolean = false;
    private interval: any;

    // Adaptive parameters
    private targetTxPerSlot: number = 100;
    private currentLoad: number = 0;

    constructor(genesisHash: string = "ZRP_GENESIS_2026", startIndex: number = 0, startHash?: string) {
        super();
        this.index = startIndex;
        this.currentHash = startHash || createHash("sha256").update(genesisHash).digest("hex");

        if (startIndex === 0) {
            this.hashQueue.push({
                index: 0,
                hash: this.currentHash,
                timestamp: Date.now(),
                txCount: 0,
                adaptiveDelay: this.baseDelay
            });
        }
    }

    private calculateAdaptiveDelay(): number {
        const loadRatio = this.currentLoad / this.targetTxPerSlot;

        if (loadRatio > 2.0) {
            return Math.max(10, this.baseDelay * 0.3);
        } else if (loadRatio > 1.0) {
            return Math.max(10, this.baseDelay * 0.6);
        } else if (loadRatio < 0.3) {
            return this.baseDelay * 2.0;
        }
        return this.baseDelay;
    }

    tick(txCount: number = 0): PoHHash {
        this.currentLoad = txCount;
        const adaptiveDelay = this.calculateAdaptiveDelay();

        this.index++;
        this.currentHash = createHash("sha256")
            .update(this.currentHash + this.index.toString() + Date.now().toString())
            .digest("hex");

        const entry: PoHHash = {
            index: this.index,
            hash: this.currentHash,
            timestamp: Date.now(),
            txCount,
            adaptiveDelay
        };

        this.hashQueue.push(entry);

        if (this.hashQueue.length > 100000) {
            this.hashQueue.shift();
        }

        this.emit("tick", entry);
        return entry;
    }

    start() {
        this.isRunning = true;
        console.log(`ZRP PoH started — base ${this.baseDelay}ms, adaptive on, resuming at slot ${this.index}`);

        const runTick = () => {
            if (!this.isRunning) return;

            const entry = this.tick(this.currentLoad);
            const nextDelay = entry.adaptiveDelay;

            this.emit("status", {
                slot: entry.index,
                hash: entry.hash.slice(0, 16),
                txs: entry.txCount,
                delay: nextDelay.toFixed(1) + "ms",
                speed: (1000 / nextDelay).toFixed(1) + " slots/sec"
            });

            this.interval = setTimeout(runTick, nextDelay);
        };

        runTick();
    }

    stop() {
        this.isRunning = false;
        clearTimeout(this.interval);
        console.log("ZRP PoH stopped");
    }

    verifySequence(startIndex: number, endIndex: number): boolean {
        const entries = this.hashQueue.slice(startIndex, endIndex + 1);
        if (entries.length < 2) return true;

        for (let i = 1; i < entries.length; i++) {
            const expected = createHash("sha256")
                .update(entries[i - 1].hash + entries[i].index.toString() + entries[i].timestamp.toString())
                .digest("hex");

            if (expected !== entries[i].hash) {
                this.emit("verification_failed", entries[i]);
                return false;
            }
        }
        return true;
    }

    getStats() {
        const recent = this.hashQueue.slice(-100);
        const avgDelay = recent.length ? recent.reduce((a, b) => a + b.adaptiveDelay, 0) / recent.length : this.baseDelay;
        const avgTxs = recent.length ? recent.reduce((a, b) => a + b.txCount, 0) / recent.length : 0;

        return {
            totalSlots: this.index,
            avgDelay: avgDelay.toFixed(2) + "ms",
            avgTxsPerSlot: avgTxs.toFixed(1),
            theoreticalTPS: ((1000 / avgDelay) * avgTxs).toFixed(0),
            currentSpeed: (1000 / avgDelay).toFixed(1) + " slots/sec",
            isRunning: this.isRunning
        };
    }

    getLatestHash(): string {
        return this.currentHash;
    }

    getLatestIndex(): number {
        return this.index;
    }

    getQueue(): PoHHash[] {
        return [...this.hashQueue];
    }

    /** Track pending load so the next tick's adaptive delay reflects real mempool size. */
    setCurrentLoad(load: number) {
        this.currentLoad = load;
    }
}
