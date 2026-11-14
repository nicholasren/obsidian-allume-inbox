import type { AfterSync, LandingMode } from "./sync";

export type SourceMode = "inbox" | "board";

export interface AllumeInboxSettings {
  helperPath: string;
  /** "inbox": Allume's built-in Inbox. "board": a named board. */
  source: SourceMode;
  /** Only this workspace's Inbox (its title). Blank: every workspace. */
  workspace: string;
  /** Resolved id. Empty means "resolve inboxBoardName on the next sync". */
  inboxBoardId: string;
  /** What the user typed or picked: usually the board's name. */
  inboxBoardName: string;
  mode: LandingMode;
  heading: string;
  dailyFolder: string;
  dailyFormat: string;
  noteFolder: string;
  marker: boolean;
  afterSync: AfterSync;
  syncedBoardId: string;
  syncedBoardName: string;
  intervalMinutes: number;
  syncOnStartup: boolean;
  launchAllume: boolean;
  notifyNew: boolean;
  /** Append every Allume request and response to debug.log in the plugin folder. */
  debugLog: boolean;
  /** Ids of cards already in the vault. */
  syncedIds: string[];
  lastSync: string;
}

export const HELPER_CANDIDATES = [
  "/Applications/Allume.app/Contents/MacOS/allume-cli",
  "/Applications/Setapp/Allume.app/Contents/MacOS/allume-cli",
  "/usr/local/bin/allume",
];

export const DEFAULT_SETTINGS: AllumeInboxSettings = {
  helperPath: HELPER_CANDIDATES[0],
  source: "inbox",
  workspace: "",
  inboxBoardId: "",
  inboxBoardName: "",
  mode: "note",
  heading: "## Captured",
  dailyFolder: "",
  dailyFormat: "",
  noteFolder: "Inbox",
  marker: true,
  afterSync: "keep",
  syncedBoardId: "",
  syncedBoardName: "",
  intervalMinutes: 5,
  syncOnStartup: true,
  launchAllume: true,
  notifyNew: true,
  debugLog: false,
  syncedIds: [],
  lastSync: "",
};

export const LEDGER_CAP = 20_000;
