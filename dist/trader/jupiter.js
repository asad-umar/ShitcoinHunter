"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JupiterTrader = void 0;
const web3_js_1 = require("@solana/web3.js");
const axios_1 = __importDefault(require("axios"));
const bs58_1 = __importDefault(require("bs58"));
const config_1 = require("../config");
const logger_1 = require("../logger");
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
class JupiterTrader {
    constructor() {
        this.connection = new web3_js_1.Connection(config_1.config.solana.rpcUrl, {
            commitment: 'confirmed',
        });
        // Decode base58 private key
        const secretKey = bs58_1.default.decode(config_1.config.solana.walletPrivateKey);
        this.wallet = web3_js_1.Keypair.fromSecretKey(secretKey);
        logger_1.logger.info(`Trader wallet: ${this.wallet.publicKey.toBase58()}`);
    }
    get walletAddress() {
        return this.wallet.publicKey.toBase58();
    }
    // ── BUY: SOL → Token ─────────────────────────────────
    async buy(mintAddress, amountSol) {
        const amountLamports = Math.floor(amountSol * web3_js_1.LAMPORTS_PER_SOL);
        logger_1.logger.info(`BUY ${amountSol} SOL → ${mintAddress}`);
        if (config_1.config.trading.dryRun) {
            logger_1.logger.info('[DRY RUN] Buy skipped');
            return {
                success: true,
                txSignature: 'DRY_RUN_TX',
                amountIn: amountSol,
                amountOut: 1000000, // fake token amount
            };
        }
        try {
            // 1. Get quote
            const quote = await this.getQuote(SOL_MINT, mintAddress, amountLamports, config_1.config.trading.slippageBps);
            if (!quote)
                throw new Error('Could not get quote from Jupiter');
            const expectedTokens = parseInt(quote.outAmount);
            const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
            if (priceImpact > 15) {
                throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);
            }
            // 2. Get swap transaction
            const swapTx = await this.getSwapTransaction(quote);
            // 3. Sign and send
            const txSignature = await this.signAndSend(swapTx);
            logger_1.logger.info(`BUY executed: ${txSignature}`);
            return {
                success: true,
                txSignature,
                amountIn: amountSol,
                amountOut: expectedTokens,
                priceImpact,
            };
        }
        catch (err) {
            logger_1.logger.error('BUY failed', { error: err.message, mint: mintAddress });
            return {
                success: false,
                error: err.message,
                amountIn: amountSol,
                amountOut: 0,
            };
        }
    }
    // ── SELL: Token → SOL ────────────────────────────────
    async sell(mintAddress, tokenAmount) {
        logger_1.logger.info(`SELL ${tokenAmount} tokens of ${mintAddress}`);
        if (config_1.config.trading.dryRun) {
            logger_1.logger.info('[DRY RUN] Sell skipped');
            return {
                success: true,
                txSignature: 'DRY_RUN_TX_SELL',
                amountIn: tokenAmount,
                amountOut: 0.19, // fake SOL amount
            };
        }
        try {
            // Get token decimals first
            const decimals = await this.getTokenDecimals(mintAddress);
            const amountRaw = Math.floor(tokenAmount * Math.pow(10, decimals));
            const quote = await this.getQuote(mintAddress, SOL_MINT, amountRaw, config_1.config.trading.slippageBps);
            if (!quote)
                throw new Error('Could not get sell quote from Jupiter');
            const solReceived = parseInt(quote.outAmount) / web3_js_1.LAMPORTS_PER_SOL;
            const swapTx = await this.getSwapTransaction(quote);
            const txSignature = await this.signAndSend(swapTx);
            logger_1.logger.info(`SELL executed: ${txSignature}, received ${solReceived.toFixed(4)} SOL`);
            return {
                success: true,
                txSignature,
                amountIn: tokenAmount,
                amountOut: solReceived,
                priceImpact: parseFloat(quote.priceImpactPct ?? '0'),
            };
        }
        catch (err) {
            logger_1.logger.error('SELL failed', { error: err.message, mint: mintAddress });
            return {
                success: false,
                error: err.message,
                amountIn: tokenAmount,
                amountOut: 0,
            };
        }
    }
    // ── Sell entire token balance ─────────────────────────
    async sellAll(mintAddress) {
        const balance = await this.getTokenBalance(mintAddress);
        if (balance <= 0) {
            return { success: false, error: 'No token balance to sell', amountIn: 0, amountOut: 0 };
        }
        return this.sell(mintAddress, balance);
    }
    // ── Helpers ───────────────────────────────────────────
    async getQuote(inputMint, outputMint, amount, slippageBps) {
        const res = await axios_1.default.get(`${JUPITER_API}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount,
                slippageBps,
                onlyDirectRoutes: false,
                asLegacyTransaction: false,
            },
            timeout: 10000,
        });
        return res.data;
    }
    async getSwapTransaction(quoteResponse) {
        const res = await axios_1.default.post(`${JUPITER_API}/swap`, {
            quoteResponse,
            userPublicKey: this.wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto', // Jito priority fee
        }, { timeout: 15000 });
        return res.data.swapTransaction;
    }
    async signAndSend(swapTransactionB64) {
        const swapTransactionBuf = Buffer.from(swapTransactionB64, 'base64');
        const transaction = web3_js_1.VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([this.wallet]);
        const rawTransaction = transaction.serialize();
        const txid = await this.connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 3,
        });
        // Wait for confirmation (up to 30s)
        const latestBlockhash = await this.connection.getLatestBlockhash();
        await this.connection.confirmTransaction({
            signature: txid,
            ...latestBlockhash,
        }, 'confirmed');
        return txid;
    }
    async getTokenBalance(mintAddress) {
        try {
            const mint = new web3_js_1.PublicKey(mintAddress);
            const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { mint });
            if (!accounts.value.length)
                return 0;
            const balance = accounts.value[0].account.data.parsed.info.tokenAmount;
            return parseFloat(balance.uiAmount ?? '0');
        }
        catch {
            return 0;
        }
    }
    async getTokenDecimals(mintAddress) {
        try {
            const info = await this.connection.getParsedAccountInfo(new web3_js_1.PublicKey(mintAddress));
            const parsed = info.value?.data?.parsed?.info;
            return parsed?.decimals ?? 6;
        }
        catch {
            return 6;
        }
    }
    async getSolBalance() {
        const lamports = await this.connection.getBalance(this.wallet.publicKey);
        return lamports / web3_js_1.LAMPORTS_PER_SOL;
    }
}
exports.JupiterTrader = JupiterTrader;
//# sourceMappingURL=jupiter.js.map