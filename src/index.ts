"use strict";
/**
 * ZRP DEVNET — ENTRY POINT
 * Run: npm start  (after npm run build)
 * Dev: npm run dev
 *
 * Env vars:
 *   ZRP_DB_PATH       path to sqlite file (default ./data/zrp.db)
 *   ZRP_API_PORT      RPC API port (default 8899)
 *   ZRP_DEMO_TRAFFIC  "off" to disable the built-in fake-traffic generator
 *   ZRP_FAUCET        "off" to disable the devnet faucet endpoints
 */

import { ZRPEngine } from "./zrp-engine";

async function main() {
    console.log("ZRP — Zero Resistance Protocol (devnet)\n");

    const engine = new ZRPEngine(process.env.ZRP_DB_PATH);
    const apiPort = parseInt(process.env.ZRP_API_PORT || "8899", 10);

    await engine.start(apiPort);

    process.on("SIGINT", () => {
        console.log("\nShutting down ZRP...");
        engine.stop();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        engine.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
