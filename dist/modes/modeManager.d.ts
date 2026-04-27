/**
 * ModeManager — resolves scanner mode (pf | grd) and execution mode (paper | real)
 *
 * Priority: CLI flag > ENV variable > default
 *
 * CLI usage:
 *   npm run dev -- --scanner=pf --execution=paper
 *   npm run dev -- --scanner=grd --execution=real
 */
export type ScannerMode = 'pf' | 'grd';
export type ExecutionMode = 'paper' | 'real';
export interface ResolvedModes {
    scanner: ScannerMode;
    execution: ExecutionMode;
    isPaper: boolean;
    isPF: boolean;
}
export declare function resolveModes(): ResolvedModes;
//# sourceMappingURL=modeManager.d.ts.map