"use strict";
/**
 * ZRP CRYPTO — Real Ed25519 keys
 *
 * Replaces the old RSA-2048-that-ignored-the-seed approach with actual
 * deterministic Ed25519 derivation: same masterSeed + index always
 * produces the same keypair, so accounts are recoverable from a seed
 * phrase the way a real wallet needs to be.
 *
 * Uses @noble/curves (pure JS, audited, synchronous API — no native
 * bindings, so it builds the same on your iPad workflow / GitHub Actions
 * / Railway without native compilation surprises).
 */

import { ed25519 } from "@noble/curves/ed25519";
import { createHash, randomBytes } from "crypto";

export interface ZRPKeyPair {
    privateKey: string; // hex, 32 bytes — NEVER store this server-side
    publicKey: string;  // hex, 32 bytes
    address: string;    // zrp1 + hash(publicKey)
}

/**
 * Derive a 32-byte Ed25519 seed from a master seed + account index.
 * Deterministic: same inputs always produce the same key.
 */
function derivePrivateKey(masterSeed: string, index: number): Uint8Array {
    const hash = createHash("sha256").update(`zrp-derive:${masterSeed}:${index}`).digest();
    return new Uint8Array(hash); // 32 bytes, valid Ed25519 seed
}

export function addressFromPublicKey(publicKeyHex: string): string {
    const hash = createHash("sha256").update(publicKeyHex).digest("hex");
    return "zrp1" + hash.slice(0, 38);
}

export function generateKeyPair(masterSeed: string, index: number): ZRPKeyPair {
    const priv = derivePrivateKey(masterSeed, index);
    const pub = ed25519.getPublicKey(priv);
    const privateKey = Buffer.from(priv).toString("hex");
    const publicKey = Buffer.from(pub).toString("hex");
    return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}

/** Generate a fresh, non-deterministic keypair (e.g. for a one-off faucet account). */
export function generateRandomKeyPair(): ZRPKeyPair {
    const priv = randomBytes(32);
    const pub = ed25519.getPublicKey(priv);
    const privateKey = priv.toString("hex");
    const publicKey = Buffer.from(pub).toString("hex");
    return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}

/** Canonical, order-stable payload used for both signing and verifying a transaction. */
export function txSigningPayload(tx: {
    id: string;
    from: string;
    to: string;
    amount: number;
    type: string;
    nonce: number;
    timestamp: number;
}): Uint8Array {
    const canonical = JSON.stringify({
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        type: tx.type,
        nonce: tx.nonce,
        timestamp: tx.timestamp
    });
    return new Uint8Array(createHash("sha256").update(canonical).digest());
}

export function signPayload(payload: Uint8Array, privateKeyHex: string): string {
    const priv = Uint8Array.from(Buffer.from(privateKeyHex, "hex"));
    const sig = ed25519.sign(payload, priv);
    return Buffer.from(sig).toString("hex");
}

export function verifyPayload(payload: Uint8Array, signatureHex: string, publicKeyHex: string): boolean {
    try {
        const sig = Uint8Array.from(Buffer.from(signatureHex, "hex"));
        const pub = Uint8Array.from(Buffer.from(publicKeyHex, "hex"));
        return ed25519.verify(sig, payload, pub);
    } catch {
        return false;
    }
}
