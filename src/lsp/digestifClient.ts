import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type DocumentSelector,
  RevealOutputChannelOn,
  type ServerOptions,
  State,
} from 'vscode-languageclient/node';
import { resolveToolchain, ToolchainError } from '../toolchain/discover';
import { buildDigestifEnv, type DigestifEnvOk } from './digestifEnv';

/** Document selectors aligned with extension activation (context + tex). */
export const DIGESTIF_DOCUMENT_SELECTOR: DocumentSelector = [
  { scheme: 'file', language: 'context' },
  { scheme: 'file', language: 'tex' },
  { scheme: 'untitled', language: 'context' },
  { scheme: 'untitled', language: 'tex' },
];

export interface DigestifClientHandle {
  /** Start or restart the client from current settings. Safe if Digestif is missing. */
  startOrRestart(): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  /** Last successful resolved env, if any. */
  lastEnv(): DigestifEnvOk | undefined;
}

/**
 * Create a Digestif LanguageClient manager. Does not start until startOrRestart().
 * Missing Digestif / XML must not break build or SyncTeX — only log + warn.
 */
export function createDigestifClient(options: {
  output: vscode.OutputChannel;
}): DigestifClientHandle {
  const { output } = options;
  let client: LanguageClient | undefined;
  let lastOk: DigestifEnvOk | undefined;
  let starting = false;

  async function stopClient(): Promise<void> {
    if (!client) {
      return;
    }
    const c = client;
    client = undefined;
    try {
      if (c.state !== State.Stopped) {
        await c.stop();
      }
    } catch (err) {
      output.appendLine(
        `[digestif] stop error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function startOrRestart(): Promise<void> {
    if (starting) {
      return;
    }
    starting = true;
    try {
      const cfg = vscode.workspace.getConfiguration('context');
      const enabled = cfg.get<boolean>('digestif.enabled', true);
      if (!enabled) {
        output.appendLine('[digestif] disabled (context.digestif.enabled=false)');
        await stopClient();
        lastOk = undefined;
        return;
      }

      let root: string | undefined;
      try {
        const toolchain = resolveToolchain();
        root = toolchain.root;
      } catch (err) {
        // Toolchain missing must not block reporting; XML still needs root.
        if (err instanceof ToolchainError) {
          output.appendLine(`[digestif] toolchain: ${err.message}`);
        }
        const rootSetting = (cfg.get<string>('root', '') ?? '').trim();
        root = rootSetting || undefined;
      }

      const digestifPathSetting = (cfg.get<string>('digestifPath', '') ?? '').trim();
      const resolved = buildDigestifEnv({
        root,
        digestifPath: digestifPathSetting || undefined,
      });

      if (!resolved.ok) {
        lastOk = undefined;
        await stopClient();
        output.appendLine(`[digestif] ${resolved.message}`);
        void vscode.window.showWarningMessage(resolved.message);
        return;
      }

      lastOk = resolved;
      output.appendLine(
        `[digestif] path=${resolved.digestifPath}  xml=${resolved.interfaceXmlPath}  ` +
          `DIGESTIF_TEXMF=${resolved.texmfDirs.join(process.platform === 'win32' ? ';' : ':')}`,
      );

      await stopClient();

      const serverOptions: ServerOptions = {
        command: resolved.digestifPath,
        args: [],
        options: {
          env: resolved.env,
        },
      };

      const clientOptions: LanguageClientOptions = {
        documentSelector: DIGESTIF_DOCUMENT_SELECTOR,
        outputChannel: output,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
      };

      const next = new LanguageClient(
        'contextDigestif',
        'Digestif (ConTeXt)',
        serverOptions,
        clientOptions,
      );

      client = next;
      try {
        await next.start();
        output.appendLine('[digestif] language client started');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[digestif] failed to start: ${msg}`);
        void vscode.window.showWarningMessage(
          `Digestif failed to start: ${msg}. Build and SyncTeX remain available.`,
        );
        client = undefined;
        lastOk = undefined;
      }
    } finally {
      starting = false;
    }
  }

  return {
    startOrRestart,
    stop: stopClient,
    dispose: () => {
      void stopClient();
    },
    lastEnv: () => lastOk,
  };
}
