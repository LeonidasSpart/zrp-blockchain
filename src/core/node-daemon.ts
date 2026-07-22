"use strict";
/**
 * ZRP NODE DAEMON — hardware detection + PoUW solving + minting
 */

import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import * as os from "os";

export class HardwareDetector {
    detectTier() {
        // FIX: `navigator` is a browser global and doesn't exist in Node —
        // this made the file fail to type-check at all under a real tsc run.
        const cpuCount = os.cpus().length;
        const memory = os.totalmem();

        if (cpuCount <= 4 && memory < 4_000_000_000) {
            return { tier: "Z1", name: "Z1-Lite", power: 1, maxWorkUnits: 1, wattage: 5 };
        } else if (cpuCount <= 8 && memory < 16_000_000_000) {
            return { tier: "Z5", name: "Z5-Gamer", power: 5, maxWorkUnits: 4, wattage: 200 };
        } else if (cpuCount <= 16 && memory < 64_000_000_000) {
            return { tier: "Z10", name: "Z10-Pro", power: 10, maxWorkUnits: 8, wattage: 500 };
        } else {
            return { tier: "Z100", name: "Z100-Cluster", power: 100, maxWorkUnits: 32, wattage: 3000 };
        }
    }
}

export interface WorkUnit {
    id: string;
    type: "protein_folding" | "climate_model" | "ai_training" | "astronomy" | "general";
    difficulty: number;
    impactScore: number;
    data: string;
    targetHash: string;
    deadline: number;
    scientistReward: number;
}

export interface PoUWProof {
    workUnitId: string;
    minerAddress: string;
    solution: string;
    hash: string;
    nonce: number;
    computeTime: number;
    energyUsed: number;
    zkProof: string;
}

export class PoUWSolver extends EventEmitter {
    private tier: any;
    private isRunning: boolean = false;
    private totalWorkDone: number = 0;
    private totalZRP: number = 0;

    constructor(tier: any) {
        super();
        this.tier = tier;
    }

    /**
     * Demo-grade "useful work": iterative hash search, capped so it
     * doesn't block the event loop for real on constrained hardware.
     * A real PoUW implementation would call out to actual scientific
     * compute (OpenMM, GROMACS, etc.) and verify the result server-side —
     * that verification step doesn't exist yet, see README notes.
     */
    async solveWorkUnit(work: WorkUnit, minerAddress: string): Promise<PoUWProof> {
        const startTime = Date.now();

        this.emit("status", `${this.tier.name} solving ${work.type}...`);

        let bestSolution = "";
        let bestHash = "f".repeat(64);
        let nonce = 0;

        const iterations = Math.min(work.difficulty * this.tier.power * 200, 200_000);

        for (let i = 0; i < iterations; i++) {
            nonce = i;
            const candidate = createHash("sha256")
                .update(work.data + nonce.toString())
                .digest("hex");

            if (candidate < bestHash) {
                bestHash = candidate;
                bestSolution = candidate;
            }
        }

        const computeTime = Date.now() - startTime;
        const energyUsed = (this.tier.wattage * computeTime) / 1000;

        const zkProof = createHash("sha256")
            .update(bestHash + work.id + minerAddress)
            .digest("hex");

        const proof: PoUWProof = {
            workUnitId: work.id,
            minerAddress,
            solution: bestSolution,
            hash: bestHash,
            nonce,
            computeTime,
            energyUsed,
            zkProof
        };

        this.totalWorkDone++;
        this.emit("solved", proof);
        return proof;
    }

    getStats() {
        return {
            tier: this.tier.name,
            totalWorkDone: this.totalWorkDone,
            totalZRP: this.totalZRP,
            isRunning: this.isRunning
        };
    }
}

export class ZRPMintingEngine {
    private genesisTime: number = Date.now();
    private halvingInterval: number = 4 * 365 * 24 * 60 * 60 * 1000;
    private baseReward: number = 50;
    private totalMinted: number = 1_000_000;
    private maxSupply: number = 21_000_000;

    calculateReward(work: WorkUnit, dailyMinerCount: number) {
        const erasPassed = Math.floor((Date.now() - this.genesisTime) / this.halvingInterval);
        const halvingFactor = Math.pow(0.5, erasPassed);
        const eraReward = this.baseReward * halvingFactor;

        const impactMultiplier = work.impactScore;
        const isSolo = dailyMinerCount <= 1;
        const democracyBonus = isSolo ? 1.5 : 1.0;

        const dailyTotal = eraReward * 144;
        const maxPerMiner = dailyTotal * 0.05;

        let reward = eraReward * impactMultiplier * democracyBonus;
        reward = Math.min(reward, maxPerMiner);

        if (this.totalMinted + reward > this.maxSupply) {
            reward = Math.max(0, this.maxSupply - this.totalMinted);
        }

        const liquidReward = reward * 0.5;
        const vestedReward = reward * 0.5;
        const scientistReward = reward * 0.1;
        const minerReward = reward * 0.9;

        this.totalMinted += reward;

        return {
            total: reward,
            liquid: liquidReward,
            vested: vestedReward,
            scientist: scientistReward,
            miner: minerReward,
            erasPassed,
            remainingSupply: this.maxSupply - this.totalMinted
        };
    }

    setTotalMinted(amount: number) {
        this.totalMinted = amount;
    }

    getMintingStats() {
        return {
            totalMinted: this.totalMinted,
            maxSupply: this.maxSupply,
            remaining: this.maxSupply - this.totalMinted,
            percentageMinted: ((this.totalMinted / this.maxSupply) * 100).toFixed(2) + "%"
        };
    }
}

export class WorkUnitRouter {
    private workQueue: WorkUnit[] = [];
    private scientists: Map<string, string> = new Map();

    addWorkUnit(type: WorkUnit["type"], difficulty: number, scientistAddr: string) {
        const impactScores: Record<string, number> = {
            protein_folding: 3.0,
            climate_model: 2.0,
            ai_training: 1.0,
            astronomy: 1.0,
            general: 0.5
        };

        const work: WorkUnit = {
            id: randomBytes(16).toString("hex"),
            type,
            difficulty,
            impactScore: impactScores[type],
            data: randomBytes(256).toString("base64"),
            targetHash: "0000" + "f".repeat(60),
            deadline: Date.now() + 3600000,
            scientistReward: 0.1
        };

        this.workQueue.push(work);
        this.scientists.set(work.id, scientistAddr);
        return work;
    }

    assignWork(tier: any): WorkUnit | null {
        const suitable = this.workQueue.filter(w => {
            if (tier.tier === "Z1") return w.difficulty <= 100;
            if (tier.tier === "Z5") return w.difficulty <= 500;
            if (tier.tier === "Z10") return w.difficulty <= 800;
            return true;
        });

        if (suitable.length === 0) return null;

        suitable.sort((a, b) => b.impactScore - a.impactScore);
        const work = suitable[0];
        this.workQueue = this.workQueue.filter(w => w.id !== work.id);
        return work;
    }

    getQueueStats() {
        const byType: Record<string, number> = {};
        this.workQueue.forEach(w => {
            byType[w.type] = (byType[w.type] || 0) + 1;
        });
        return { total: this.workQueue.length, byType };
    }
}

export class ZRPNode {
    public detector: HardwareDetector;
    public solver: PoUWSolver;
    public minting: ZRPMintingEngine;
    public router: WorkUnitRouter;
    public tier: any;
    public minerAddress: string;
    private interval: any;
    private onReward?: (reward: ReturnType<ZRPMintingEngine["calculateReward"]>, minerAddress: string) => void;

    constructor(minerAddress: string) {
        this.detector = new HardwareDetector();
        this.tier = this.detector.detectTier();
        this.solver = new PoUWSolver(this.tier);
        this.minting = new ZRPMintingEngine();
        this.router = new WorkUnitRouter();
        this.minerAddress = minerAddress;

        this.solver.on("status", (msg: string) => console.log(msg));
        this.solver.on("solved", (proof: PoUWProof) => {
            console.log(`Solved work unit — hash ${proof.hash.slice(0, 16)}...`);
        });
    }

    onRewardMinted(cb: (reward: ReturnType<ZRPMintingEngine["calculateReward"]>, minerAddress: string) => void) {
        this.onReward = cb;
    }

    async start() {
        console.log(`ZRP node starting — tier ${this.tier.name} (${this.tier.tier}), ${this.tier.wattage}W, address ${this.minerAddress}`);

        this.router.addWorkUnit("protein_folding", 200, "scientist_1_zrp");
        this.router.addWorkUnit("climate_model", 150, "scientist_2_zrp");
        this.router.addWorkUnit("ai_training", 300, "scientist_3_zrp");

        this.interval = setInterval(async () => {
            const work = this.router.assignWork(this.tier);
            if (work) {
                const proof = await this.solver.solveWorkUnit(work, this.minerAddress);
                const reward = this.minting.calculateReward(work, 1);
                if (this.onReward) this.onReward(reward, this.minerAddress);
            }
        }, 5000);
    }

    stop() {
        clearInterval(this.interval);
        console.log("ZRP node stopped");
    }

    getStats() {
        return {
            node: this.solver.getStats(),
            minting: this.minting.getMintingStats(),
            workQueue: this.router.getQueueStats()
        };
    }
}
