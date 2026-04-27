import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import { config } from '../config';
import { TradeResult } from '../types';
import { logger } from '../logger';

const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class JupiterTrader {
  private connection: Connection;
  private wallet: Keypair;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
    });

    // Decode base58 private key
    const secretKey = bs58.decode(config.solana.walletPrivateKey);
    this.wallet = Keypair.fromSecretKey(secretKey);

    logger.info(`Trader wallet: ${this.wallet.publicKey.toBase58()}`);
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  // ── BUY: SOL → Token ─────────────────────────────────
  async buy(mintAddress: string, amountSol: number): Promise<TradeResult> {
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    logger.info(`BUY ${amountSol} SOL → ${mintAddress}`);

    if (config.trading.dryRun) {
      logger.info('[DRY RUN] Buy skipped');
      return {
        success: true,
        txSignature: 'DRY_RUN_TX',
        amountIn: amountSol,
        amountOut: 1_000_000, // fake token amount
      };
    }

    try {
      // 1. Get quote
      const quote = await this.getQuote(
        SOL_MINT,
        mintAddress,
        amountLamports,
        config.trading.slippageBps
      );

      if (!quote) throw new Error('Could not get quote from Jupiter');

      const expectedTokens = parseInt(quote.outAmount);
      const priceImpact = parseFloat(quote.priceImpactPct ?? '0');

      if (priceImpact > 15) {
        throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}%`);
      }

      // 2. Get swap transaction
      const swapTx = await this.getSwapTransaction(quote);

      // 3. Sign and send
      const txSignature = await this.signAndSend(swapTx);

      logger.info(`BUY executed: ${txSignature}`);

      return {
        success: true,
        txSignature,
        amountIn: amountSol,
        amountOut: expectedTokens,
        priceImpact,
      };
    } catch (err: any) {
      logger.error('BUY failed', { error: err.message, mint: mintAddress });
      return {
        success: false,
        error: err.message,
        amountIn: amountSol,
        amountOut: 0,
      };
    }
  }

  // ── SELL: Token → SOL ────────────────────────────────
  async sell(mintAddress: string, tokenAmount: number): Promise<TradeResult> {
    logger.info(`SELL ${tokenAmount} tokens of ${mintAddress}`);

    if (config.trading.dryRun) {
      logger.info('[DRY RUN] Sell skipped');
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

      const quote = await this.getQuote(
        mintAddress,
        SOL_MINT,
        amountRaw,
        config.trading.slippageBps
      );

      if (!quote) throw new Error('Could not get sell quote from Jupiter');

      const solReceived = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;

      const swapTx = await this.getSwapTransaction(quote);
      const txSignature = await this.signAndSend(swapTx);

      logger.info(`SELL executed: ${txSignature}, received ${solReceived.toFixed(4)} SOL`);

      return {
        success: true,
        txSignature,
        amountIn: tokenAmount,
        amountOut: solReceived,
        priceImpact: parseFloat(quote.priceImpactPct ?? '0'),
      };
    } catch (err: any) {
      logger.error('SELL failed', { error: err.message, mint: mintAddress });
      return {
        success: false,
        error: err.message,
        amountIn: tokenAmount,
        amountOut: 0,
      };
    }
  }

  // ── Sell entire token balance ─────────────────────────
  async sellAll(mintAddress: string): Promise<TradeResult> {
    const balance = await this.getTokenBalance(mintAddress);
    if (balance <= 0) {
      return { success: false, error: 'No token balance to sell', amountIn: 0, amountOut: 0 };
    }
    return this.sell(mintAddress, balance);
  }

  // ── Helpers ───────────────────────────────────────────
  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number
  ): Promise<any> {
    const res = await axios.get(`${JUPITER_API}/quote`, {
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

  private async getSwapTransaction(quoteResponse: any): Promise<string> {
    const res = await axios.post(
      `${JUPITER_API}/swap`,
      {
        quoteResponse,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto', // Jito priority fee
      },
      { timeout: 15000 }
    );
    return res.data.swapTransaction;
  }

  private async signAndSend(swapTransactionB64: string): Promise<string> {
    const swapTransactionBuf = Buffer.from(swapTransactionB64, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([this.wallet]);

    const rawTransaction = transaction.serialize();
    const txid = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Wait for confirmation (up to 30s)
    const latestBlockhash = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction(
      {
        signature: txid,
        ...latestBlockhash,
      },
      'confirmed'
    );

    return txid;
  }

  async getTokenBalance(mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint }
      );

      if (!accounts.value.length) return 0;

      const balance = accounts.value[0].account.data.parsed.info.tokenAmount;
      return parseFloat(balance.uiAmount ?? '0');
    } catch {
      return 0;
    }
  }

  async getTokenDecimals(mintAddress: string): Promise<number> {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const parsed = (info.value?.data as any)?.parsed?.info;
      return parsed?.decimals ?? 6;
    } catch {
      return 6;
    }
  }

  async getSolBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }
}
