"use strict";
/**
 * ZRP TOWER BFT — Optimistic Confirmation with Slashing
 */

import { randomBytes } from "crypto";
import { EventEmitter } from "events";

export interface Validator {
    address: string;
    stake: number;
    tier: "Z1" | "Z5" | "Z10" | "Z100";
    lastVote: number;
    voteHistory: Vote[];
    slashCount: number;
    isActive: boolean;
    latency: number;
}

export interface Vote {
    slot: number;
    hash: string;
    timestamp: number;
    signature: string;
    confidence: number;
}

export interface Block {
    slot: number;
    pohHash: string;
    transactions: any[];
    stateRoot: string;
    validatorVotes: Vote[];
    confirmationStatus: "pending" | "optimistic" | "finalized";
    proposedAt: number;
    finalizedAt?: number;
}

export class ZRPTowerBFT extends EventEmitter {
    private validators: Map<string, Validator> = new Map();
    private blocks: Map<number, Block> = new Map();
    private currentSlot: number = 0;
    private supermajorityThreshold: number = 0.667;
    private optimisticThreshold: number = 0.5;
    private totalStake: number = 0;
    private slashingEnabled: boolean = true;

    registerValidator(address: string, stake: number, tier: Validator["tier"], latency: number = 100) {
        if (stake < 1) {
            throw new Error("Minimum stake: 1 ZRP");
        }

        const validator: Validator = {
            address,
            stake,
            tier,
            lastVote: 0,
            voteHistory: [],
            slashCount: 0,
            isActive: true,
            latency
        };

        this.validators.set(address, validator);
        this.totalStake += stake;

        this.emit("validator_registered", { address, stake, tier });
        return validator;
    }

    setCurrentSlot(slot: number) {
        this.currentSlot = slot;
    }

    proposeBlock(pohHash: string, transactions: any[], stateRoot: string): Block {
        this.currentSlot++;

        const block: Block = {
            slot: this.currentSlot,
            pohHash,
            transactions,
            stateRoot,
            validatorVotes: [],
            confirmationStatus: "pending",
            proposedAt: Date.now()
        };

        this.blocks.set(this.currentSlot, block);
        this.emit("block_proposed", block);

        return block;
    }

    async castVote(validatorAddress: string, slot: number, blockHash: string): Promise<Vote | null> {
        const validator = this.validators.get(validatorAddress);
        if (!validator || !validator.isActive) return null;

        await new Promise(r => setTimeout(r, validator.latency));

        const existingVote = this.blocks.get(slot)?.validatorVotes.find(
            v => v.signature.startsWith(validatorAddress.slice(0, 8))
        );

        if (existingVote && existingVote.hash !== blockHash) {
            if (this.slashingEnabled) {
                this.slashValidator(validatorAddress, "double_vote");
                return null;
            }
        }

        const vote: Vote = {
            slot,
            hash: blockHash,
            timestamp: Date.now(),
            signature: validatorAddress + "_" + randomBytes(8).toString("hex"),
            confidence: validator.stake / this.totalStake
        };

        validator.lastVote = slot;
        validator.voteHistory.push(vote);

        const block = this.blocks.get(slot);
        if (block) {
            block.validatorVotes.push(vote);
            this.checkConfirmation(block);
        }

        this.emit("vote_cast", { validator: validatorAddress, slot, confidence: vote.confidence });
        return vote;
    }

    private checkConfirmation(block: Block) {
        const totalVotedStake = block.validatorVotes.reduce((sum, v) => {
            const val = this.validators.get(v.signature.split("_")[0]);
            return sum + (val?.stake || 0);
        }, 0);

        const voteRatio = totalVotedStake / this.totalStake;

        if (voteRatio >= this.supermajorityThreshold && block.confirmationStatus !== "finalized") {
            block.confirmationStatus = "finalized";
            block.finalizedAt = Date.now();
            this.emit("block_finalized", {
                slot: block.slot,
                // FIX: this used to be a no-op (`x - (x - 1000)` is always 1000).
                // Now it's the real wall-clock time from proposal to finality.
                finalityTime: block.finalizedAt - block.proposedAt,
                voteRatio: (voteRatio * 100).toFixed(1) + "%"
            });
        } else if (voteRatio >= this.optimisticThreshold && block.confirmationStatus === "pending") {
            block.confirmationStatus = "optimistic";
            this.emit("block_optimistic", { slot: block.slot, voteRatio: (voteRatio * 100).toFixed(1) + "%" });
        }
    }

    private slashValidator(address: string, reason: string) {
        const validator = this.validators.get(address);
        if (!validator) return;

        validator.slashCount++;
        const slashAmount = validator.stake * 0.1;
        validator.stake -= slashAmount;
        this.totalStake -= slashAmount;

        if (validator.slashCount >= 3) {
            validator.isActive = false;
            this.emit("validator_banned", { address, reason, slashAmount });
        } else {
            this.emit("validator_slashed", { address, reason, slashAmount, remainingStake: validator.stake });
        }
    }

    async simulateNetworkVote(slot: number) {
        const block = this.blocks.get(slot);
        if (!block) return;

        const activeValidators = Array.from(this.validators.values()).filter(v => v.isActive);

        const votePromises = activeValidators.map(v =>
            this.castVote(v.address, slot, block.pohHash)
        );

        await Promise.all(votePromises);
    }

    adjustThreshold() {
        const active = Array.from(this.validators.values()).filter(v => v.isActive);
        if (active.length === 0) return;
        const avgLatency = active.reduce((a, b) => a + b.latency, 0) / active.length;

        if (avgLatency > 500) {
            this.supermajorityThreshold = 0.6;
            this.emit("threshold_adjusted", { reason: "high_latency", newThreshold: "60%" });
        } else {
            this.supermajorityThreshold = 0.667;
            this.emit("threshold_adjusted", { reason: "healthy", newThreshold: "66.7%" });
        }
    }

    getStats() {
        const activeValidators = Array.from(this.validators.values()).filter(v => v.isActive);
        // FIX: was dividing by this.validators.size (includes inactive/banned
        // validators), which skewed the average once anyone got slashed out.
        const avgLatency = activeValidators.length
            ? activeValidators.reduce((a, b) => a + b.latency, 0) / activeValidators.length
            : 0;

        return {
            totalValidators: this.validators.size,
            activeValidators: activeValidators.length,
            totalStake: this.totalStake,
            currentSlot: this.currentSlot,
            finalizedBlocks: Array.from(this.blocks.values()).filter(b => b.confirmationStatus === "finalized").length,
            avgLatency: avgLatency.toFixed(0) + "ms",
            threshold: (this.supermajorityThreshold * 100).toFixed(1) + "%"
        };
    }

    getBlock(slot: number): Block | undefined {
        return this.blocks.get(slot);
    }
}
