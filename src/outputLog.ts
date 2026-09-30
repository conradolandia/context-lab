import * as vscode from 'vscode';

/** Main user-facing build / lifecycle channel. */
export const USER_CHANNEL_NAME = 'ConTeXt';

/** Verbose internal traces (viewer, gate, SyncTeX dumps, project scan timing). */
export const DEBUG_CHANNEL_NAME = 'ConTeXt debug';

const DEBUG_SETTING = 'debugOutput';

let userChannel: vscode.OutputChannel | undefined;
let debugChannel: vscode.OutputChannel | undefined;
let debugEnabled = false;
let subscriptionBag: { push(...items: { dispose(): void }[]): number } | undefined;

function isDebugOutputEnabled(): boolean {
  return vscode.workspace.getConfiguration('context').get<boolean>(DEBUG_SETTING, false) === true;
}

/**
 * Create the main ConTeXt channel. Debug channel is created lazily when
 * `context.debugOutput` is true (default false).
 */
export function initOutputLog(subscriptions: {
  push(...items: { dispose(): void }[]): number;
}): {
  user: vscode.OutputChannel;
} {
  subscriptionBag = subscriptions;
  userChannel = vscode.window.createOutputChannel(USER_CHANNEL_NAME);
  subscriptions.push(userChannel);
  debugEnabled = isDebugOutputEnabled();
  if (debugEnabled) {
    ensureDebugChannel();
  }
  subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`context.${DEBUG_SETTING}`)) {
        return;
      }
      const was = debugEnabled;
      debugEnabled = isDebugOutputEnabled();
      if (debugEnabled) {
        ensureDebugChannel();
        if (!was) {
          logDebug(`[debug] context.debugOutput=true (writing to ${DEBUG_CHANNEL_NAME})`);
        }
      }
    }),
  );
  return { user: userChannel };
}

function ensureDebugChannel(): vscode.OutputChannel | undefined {
  if (debugChannel) {
    return debugChannel;
  }
  if (!debugEnabled) {
    return undefined;
  }
  debugChannel = vscode.window.createOutputChannel(DEBUG_CHANNEL_NAME);
  subscriptionBag?.push(debugChannel);
  return debugChannel;
}

/** User-facing line on the ConTeXt channel. */
export function logUser(line: string): void {
  userChannel?.appendLine(line);
}

/** Debug line on ConTeXt debug; no-op unless context.debugOutput is true. */
export function logDebug(line: string): void {
  if (!debugEnabled) {
    return;
  }
  ensureDebugChannel()?.appendLine(line);
}

/** The main ConTeXt OutputChannel (for build streaming and commands that need it). */
export function getUserOutputChannel(): vscode.OutputChannel {
  if (!userChannel) {
    throw new Error('Output log not initialized');
  }
  return userChannel;
}
