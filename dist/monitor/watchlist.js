"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WatchList = void 0;
const logger_1 = require("../logger");
class WatchList {
    constructor() {
        this.items = new Map();
        this.RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
        this.MAX_RECHECKS = 3;
        this.MAX_AGE_MS = 20 * 60 * 1000; // drop after 20 min
    }
    add(scored) {
        const mint = scored.token.mintAddress;
        if (this.items.has(mint))
            return;
        this.items.set(mint, {
            scored,
            addedAt: new Date(),
            recheckAt: new Date(Date.now() + this.RECHECK_INTERVAL_MS),
            recheckCount: 0,
        });
        logger_1.logger.info(`Watchlist: added $${scored.token.ticker} (score ${scored.vibe.vibeScore})`);
    }
    getDue() {
        const now = Date.now();
        const due = [];
        for (const [mint, item] of this.items) {
            // Expired
            if (now - item.addedAt.getTime() > this.MAX_AGE_MS) {
                this.items.delete(mint);
                continue;
            }
            // Max rechecks hit
            if (item.recheckCount >= this.MAX_RECHECKS) {
                this.items.delete(mint);
                continue;
            }
            if (now >= item.recheckAt.getTime()) {
                due.push(item.scored);
                item.recheckCount++;
                item.recheckAt = new Date(now + this.RECHECK_INTERVAL_MS);
            }
        }
        return due;
    }
    remove(mintAddress) {
        this.items.delete(mintAddress);
    }
    get size() {
        return this.items.size;
    }
}
exports.WatchList = WatchList;
//# sourceMappingURL=watchlist.js.map