"use strict";
/**
 * ModeManager — resolves scanner mode (pf | grd) and execution mode (paper | real)
 *
 * Priority: CLI flag > ENV variable > default
 *
 * CLI usage:
 *   npm run dev -- --scanner=pf --execution=paper
 *   npm run dev -- --scanner=grd --execution=real
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveModes = resolveModes;
const logger_1 = require("../logger");
function parseArg(name) {
    const flag = `--${name}=`;
    const arg = process.argv.find((a) => a.startsWith(flag));
    return arg ? arg.slice(flag.length).toLowerCase() : null;
}
function resolveModes() {
    // Scanner mode
    const scannerCli = parseArg('scanner');
    const scannerEnv = (process.env.SCANNER_MODE ?? '').toLowerCase();
    const scannerRaw = scannerCli ?? scannerEnv ?? 'pf';
    if (scannerRaw !== 'pf' && scannerRaw !== 'grd') {
        throw new Error(`Invalid scanner mode "${scannerRaw}" — must be "pf" or "grd"`);
    }
    const scanner = scannerRaw;
    // Execution mode
    const execCli = parseArg('execution');
    const execEnv = (process.env.EXECUTION_MODE ?? '').toLowerCase();
    const execRaw = execCli ?? execEnv ?? 'paper';
    if (execRaw !== 'paper' && execRaw !== 'real') {
        throw new Error(`Invalid execution mode "${execRaw}" — must be "paper" or "real"`);
    }
    const execution = execRaw;
    const resolved = {
        scanner,
        execution,
        isPaper: execution === 'paper',
        isPF: scanner === 'pf',
    };
    logger_1.logger.info(`[Mode] Scanner: ${scanner.toUpperCase()} | Execution: ${execution.toUpperCase()}`);
    if (resolved.isPaper) {
        logger_1.logger.info('[Mode] PAPER mode — no real trades will be executed');
    }
    else {
        logger_1.logger.warn('[Mode] REAL mode — live trades WILL be executed with real SOL');
    }
    return resolved;
}
//# sourceMappingURL=modeManager.js.map