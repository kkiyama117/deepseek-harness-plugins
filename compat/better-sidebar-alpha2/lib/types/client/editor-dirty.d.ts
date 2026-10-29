/**
 * Unsaved-edit registry: which editor tabs currently hold a draft that
 * differs from disk. The editor host registers its tab's dirty state here
 * (the toolbar report already carries it), so the flows that would silently
 * drop the draft can ask first:
 *
 * - the sidebar's tab close (the X button, the middle click, the tab context
 *   menu, and the tree's close-on-rename/delete path all land there),
 * - the browser unload (refresh / close tab / navigate away) through a
 *   `beforeunload` guard.
 *
 * Module-level and keyed by tab id — the same "one instance per client plugin
 * activation" lifetime the store has, since the module only loads with the
 * client bundle. An entry is written while a tab is dirty and deleted the
 * moment it goes clean (save) or its host unmounts (tab closed, session
 * switched), so a stale entry can never keep a guard armed.
 */
/**
 * Publish one tab's dirty state: `true` registers the draft (session + path
 * ride along for scoped queries), `false` / `undefined` clears it.
 */
export declare function setEditorDirty(tabId: string, dirty: boolean, sessionId: string, path: string): void;
/** Drop a tab's entry (its editor host unmounted). Idempotent. */
export declare function clearEditorDirty(tabId: string): void;
/** Whether one tab holds an unsaved draft. */
export declare function isEditorDirty(tabId: string): boolean;
/** How many tabs of one session hold unsaved drafts. */
export declare function dirtyCountForSession(sessionId: string): number;
/** How many tabs hold unsaved drafts across every session (the unload guard). */
export declare function dirtyCount(): number;
/** Subscribe to dirty-set changes; returns the disposer. */
export declare function subscribeEditorDirty(listener: () => void): () => void;
/** The change counter (a stable `useSyncExternalStore` snapshot). */
export declare function editorDirtyRevision(): number;
/**
 * Ask before dropping `tabId`'s unsaved draft. Returns true when the caller
 * may proceed (the tab is clean, the user confirmed, or no `confirm` is
 * available — the same fallback the refresh guard uses). On confirm the
 * entry is cleared immediately, so a follow-up close in the same tick does
 * not double-prompt; the editor host's own cleanup would do it one commit
 * later anyway.
 *
 * Shared by the sidebar's tab close and the file tree's close-on-delete so
 * both paths warn exactly once, with the same copy.
 */
export declare function confirmDiscardDraft(tabId: string, message: string): boolean;
