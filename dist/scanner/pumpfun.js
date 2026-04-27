"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpFunScanner = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../logger");
// Pump.fun API returns coins in reverse chronological order
const PUMPFUN_API = 'https://frontend-api.pump.fun/coins';
class PumpFunScanner {
    constructor() {
        this.seenMints = new Set();
        this.lastCheckTime = Date.now();
    }
    async getLatestTokens() {
        try {
            const response = await axios_1.default.get(PUMPFUN_API, {
                params: {
                    offset: 0,
                    limit: 50,
                    sort: 'creation_time',
                    order: 'DESC',
                    includeNsfw: false,
                },
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json',
                },
            });
            const coins = response.data;
            if (!Array.isArray(coins))
                return [];
            const newTokens = [];
            for (const coin of coins) {
                const mint = coin.mint;
                // Skip already seen
                if (this.seenMints.has(mint))
                    continue;
                this.seenMints.add(mint);
                // Only process coins created after our last check
                const createdAt = new Date(coin.created_timestamp);
                if (createdAt.getTime() < this.lastCheckTime - 60000)
                    continue;
                newTokens.push({
                    mintAddress: mint,
                    name: coin.name ?? 'Unknown',
                    ticker: (coin.symbol ?? 'UNKNOWN').toUpperCase(),
                    description: coin.description ?? '',
                    creatorWallet: coin.creator ?? '',
                    createdAt,
                    pumpfunUrl: `https://pump.fun/${mint}`,
                    imageUrl: coin.image_uri,
                });
            }
            this.lastCheckTime = Date.now();
            // Prevent the seen set from growing unbounded
            if (this.seenMints.size > 5000) {
                const arr = Array.from(this.seenMints);
                this.seenMints = new Set(arr.slice(-2000));
            }
            if (newTokens.length > 0) {
                logger_1.logger.info(`PumpFun: found ${newTokens.length} new tokens`);
            }
            return newTokens;
        }
        catch (err) {
            logger_1.logger.error('PumpFun scanner error', { error: err.message });
            return [];
        }
    }
}
exports.PumpFunScanner = PumpFunScanner;
//# sourceMappingURL=pumpfun.js.map