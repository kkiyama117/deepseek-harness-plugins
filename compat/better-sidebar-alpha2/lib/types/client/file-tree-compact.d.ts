/**
 * Pure logic behind the explorer's breadcrumb folder compaction (VSCode's
 * "compact folders"): a directory whose contents are exactly one child
 * (host flag `compact`) folds together with its sole directory children
 * into one `a/b/c` row — the chain extends only through DIRECTORY links,
 * the terminal link's sole child may be a file. The host only ever marks
 * non-symlink children, so a fold chain can never cycle through the
 * filesystem — the visited guard is belt-and-braces against a stale or
 * hostile cache. The chain walk skips POSIX-hidden entries (the host probe
 * marks `compact` with the same filter), so junk like macOS's `.DS_Store`
 * beside the sole child never snaps a chain open — regardless of whether
 * the user's "show hidden files" switch renders them.
 */
import type { FsEntry } from './api.ts';
/** One cached level as FileTree stores it (entries arrive async; error set on failure). */
export interface CompactLevel {
    entries?: FsEntry[];
    error?: string;
}
/**
 * Safety cap on one fold chain. Real directories cannot cycle, so this is
 * never reached on a healthy cache — it bounds the chain when a stale cache
 * lies about a level's contents.
 */
export declare const MAX_COMPACT_DEPTH = 32;
/**
 * The fold chain starting at `entry`: successive sole directory children
 * while each link's level is loaded, still holds exactly one healthy
 * directory child, and the chain stays within the depth cap. The returned
 * chain always starts with `entry` itself; its LAST element is the level
 * the expanded row renders.
 */
export declare function compactChain(entry: FsEntry, levelOf: (path: string) => CompactLevel | undefined): FsEntry[];
/**
 * The collapsed singleton directories whose levels still need loading, so
 * fold chains can extend past what the user has expanded. Scans every
 * LOADED level once; each arrival may reveal the next link, so the caller
 * re-runs this after every cache update. Chains cannot cycle (host never
 * marks symlink children), so the walk terminates at the chain's real end.
 */
export declare function compactLoadTargets(levels: Record<string, CompactLevel>): string[];
