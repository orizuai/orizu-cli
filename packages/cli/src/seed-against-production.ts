/**
 * ORI-2128: what `optimizations promote` needs to warn about a stale seed.
 * The run's seed version number, and its profile's production version number
 * as it stood before this promotion (null when the profile had none).
 * Shared by the promote handler, both promote routes, and the CLI.
 */
export interface SeedAgainstProduction {
  runSeedVersionNumber: number
  productionVersionNumber: number | null
}
