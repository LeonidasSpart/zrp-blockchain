"use strict";
/**
 * ZRP ADAPTIVE SHARD ROUTER
 * Splits transactions into parallel execution lanes
 */

import { EventEmitter } from "events";

export interface Transaction {
    id: string;
    from: string;
    to: string;
    amount: number;
    type: "transfer" | "stake" | "unstake" | "contract" | "science_grant";
    data?: string;
    nonce: number;
    signature: string;
    publicKey: string;
    timestamp: number;
}

export interface ShardLane {
    id: number;
    transactions: Transaction[];
    stateRoot: string;
    executionTime: number;
    isExecuting: boolean;
}

export class ZRPShardRouter extends EventEmitter {
    private lanes: ShardLane[] = [];
    private baseLaneCount: number = 2;
    private maxLaneCount: number = 16;
    private currentLaneCount: number = 2;
    private pendingTxs: Transaction[] = [];
    private accountLaneMap: Map<string, number> = new Map();

    constructor() {
        super();
        this.initializeLanes();
    }

    private initializeLanes() {
        this.lanes = [];
        for (let i = 0; i < this.currentLaneCount; i++) {
            this.lanes.push({
                id: i,
                transactions: [],
                stateRoot: "",
                executionTime: 0,
                isExecuting: false
            });
        }
    }

    private scaleLanes() {
        const load = this.pendingTxs.length;

        let targetLanes = this.baseLaneCount;
        if (load > 500) targetLanes = 16;
        else if (load > 200) targetLanes = 8;
        else if (load > 50) targetLanes = 4;
        else targetLanes = 2;

        if (targetLanes !== this.currentLaneCount) {
            const oldCount = this.currentLaneCount;
            const oldLanes = [...this.lanes];
            this.currentLaneCount = targetLanes;
            this.initializeLanes();

            // FIX: the old lane->account map is invalid once lane count
            // changes (an account could point at a lane index that no
            // longer exists). Clear it and let assignToLane rebuild it
            // against the new lane count.
            this.accountLaneMap.clear();

            for (const lane of oldLanes) {
                for (const tx of lane.transactions) {
                    this.assignToLane(tx);
                }
            }

            this.emit("scaled", { from: oldCount, to: targetLanes, reason: `load=${load}` });
        }
    }

    private assignToLane(tx: Transaction): number {
        if (this.accountLaneMap.has(tx.from)) {
            const laneId = this.accountLaneMap.get(tx.from)!;
            this.lanes[laneId].transactions.push(tx);
            return laneId;
        }

        let minLoad = Infinity;
        let minLane = 0;

        for (let i = 0; i < this.currentLaneCount; i++) {
            if (this.lanes[i].transactions.length < minLoad) {
                minLoad = this.lanes[i].transactions.length;
                minLane = i;
            }
        }

        this.accountLaneMap.set(tx.from, minLane);
        this.lanes[minLane].transactions.push(tx);
        return minLane;
    }

    addTransaction(tx: Transaction) {
        this.pendingTxs.push(tx);
        this.scaleLanes();
        const laneId = this.assignToLane(tx);

        this.emit("tx_added", { tx: tx.id, lane: laneId, poolSize: this.pendingTxs.length });
        return laneId;
    }

    getPendingCount(): number {
        return this.pendingTxs.length;
    }

    async executeBlock(): Promise<{ laneResults: any[], totalTxs: number, totalTime: number }> {
        const startTime = Date.now();

        const lanePromises = this.lanes.map(async (lane) => {
            if (lane.transactions.length === 0) return null;

            lane.isExecuting = true;
            const laneStart = Date.now();

            const results = lane.transactions.map(tx => ({
                tx: tx.id,
                success: true,
                gasUsed: Math.floor(Math.random() * 1000) + 100
            }));

            lane.executionTime = Date.now() - laneStart;
            lane.stateRoot = "state_" + lane.id + "_" + Date.now();
            lane.isExecuting = false;

            const executedTxs = lane.transactions;
            const txCount = lane.transactions.length;
            lane.transactions = [];

            return {
                laneId: lane.id,
                txCount,
                executionTime: lane.executionTime,
                stateRoot: lane.stateRoot,
                results,
                transactions: executedTxs
            };
        });

        const laneResults = (await Promise.all(lanePromises)).filter(r => r !== null) as any[];
        const totalTime = Date.now() - startTime;

        this.pendingTxs = [];
        this.accountLaneMap.clear();

        this.emit("block_executed", {
            lanes: laneResults.length,
            totalTxs: laneResults.reduce((a, b) => a + b.txCount, 0),
            totalTime,
            tps: (laneResults.reduce((a, b) => a + b.txCount, 0) / (totalTime / 1000)).toFixed(0)
        });

        return {
            laneResults,
            totalTxs: laneResults.reduce((a, b) => a + b.txCount, 0),
            totalTime
        };
    }

    getStats() {
        const totalPending = this.lanes.reduce((a, b) => a + b.transactions.length, 0);
        return {
            laneCount: this.currentLaneCount,
            totalPending,
            lanes: this.lanes.map(l => ({
                id: l.id,
                txCount: l.transactions.length,
                isExecuting: l.isExecuting
            }))
        };
    }
}
