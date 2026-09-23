import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type DocumentSelector,
  RevealOutputChannelOn,
  type ServerOptions,
  State,
  ErrorAction,
  CloseAction,
} from 'vscode-languageclient/node';
import { resolveToolchain, ToolchainError } from '../toolchain/discover';
import { buildDigestifEnv, type DigestifEnvOk } from './digestifEnv';
import { probeDigestif, spawnDigestifServer } from './digestifProcess';

/** Distinct from Marketplace `digestif` (phil.red) client ids. */
export const DIGESTIF_CLIENT_ID = 'contextSyncTeX.digestif';
export const DIGESTIF_CLIENT_NAME = 'ConTeXt SyncTeX Digestif';

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
 * LanguageClient that never throws from stop()/dispose() when not Running.
 * vscode-languageclient calls `void this.stop()` on init failure while state is
 * still Starting/StartFailed, which otherwise becomes uncaught Extension Host errors.
 */
class SafeLanguageClient extends LanguageClient {
  override stop(timeout?: number): Promise<void> {
    if (this.state !== State.Running) {
      return Promise.resolve();
    }
    return super.stop(timeout).catch((err: unknown) => {
      void err;
    });
  }

  override dispose(timeout?: number): Promise<void> {
    if (this.state !== State.Running) {
      return Promise.resolve();
    }
    return super.dispose(timeout).catch((err: unknown) => {
      void err;
    });
  }
}

/**
 * Create a Digestif LanguageClient manager. Does not start until startOrRestart().
 * Missing Digestif / XML must not break build or SyncTeX — only log + warn.
 */
export function createDigestifClient(options: {
  output: vscode.OutputChannel;
}): DigestifClientHandle {
  const { output } = options;
  const log = (line: string) => {
    output.appendLine(line);
  };
  let client: SafeLanguageClient | undefined;
  let lastOk: DigestifEnvOk | undefined;
  let starting = false;
  let generation = 0;

  async function stopClient(): Promise<void> {
    const c = client;
    client = undefined;
    if (!c) {
      return;
    }
    try {
      if (c.state === State.Running) {
        await c.stop();
      }
    } catch (err) {
      log(`[digestif] stop error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function startOrRestart(): Promise<void> {
    if (starting) {
      log('[digestif] start already in progress; skipping concurrent restart');
      return;
    }
    starting = true;
    const gen = ++generation;
    try {
      const cfg = vscode.workspace.getConfiguration('context');
      const enabled = cfg.get<boolean>('digestif.enabled', true);
      if (!enabled) {
        log('[digestif] disabled (context.digestif.enabled=false)');
        await stopClient();
        lastOk = undefined;
        return;
      }

      let root: string | undefined;
      let contextBin = '';
      let mtxrunBin = '';
      try {
        const toolchain = resolveToolchain();
        root = toolchain.root;
        contextBin = toolchain.contextPath;
        mtxrunBin = toolchain.mtxrunPath;
      } catch (err) {
        if (err instanceof ToolchainError) {
          log(`[digestif] toolchain: ${err.message}`);
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
        log(`[digestif] ${resolved.message}`);
        void vscode.window.showWarningMessage(resolved.message);
        return;
      }

      if (gen !== generation) {
        return;
      }

      lastOk = resolved;
      log(
        `[digestif] root=${resolved.root}  context=${contextBin || '(n/a)'}  ` +
          `mtxrun=${mtxrunBin || '(n/a)'}  digestif=${resolved.digestifPath}`,
      );
      log(
        `[digestif] xml=${resolved.interfaceXmlPath}  ` +
          `DIGESTIF_TEXMF=${resolved.texmfDirs.join(process.platform === 'win32' ? ';' : ':')}`,
      );
      if (resolved.env.PATH) {
        const pathPreview = resolved.env.PATH.split(process.platform === 'win32' ? ';' : ':')
          .slice(0, 6)
          .join(process.platform === 'win32' ? ';' : ':');
        log(`[digestif] PATH(prefix)=${pathPreview}`);
      }
      if (resolved.env.TEXLUA) {
        log(`[digestif] TEXLUA=${resolved.env.TEXLUA}`);
      }

      const probe = await probeDigestif(resolved.digestifPath, resolved.env, log);
      if (!probe.ok) {
        lastOk = undefined;
        await stopClient();
        const msg =
          `Digestif did not start: ${probe.detail} ` +
          `Build and SyncTeX remain available. ` +
          `(If Marketplace extension "Digestif" is also installed, disable it while testing this one.)`;
        log(`[digestif] ${msg}`);
        void vscode.window.showWarningMessage(msg);
        return;
      }

      if (gen !== generation) {
        return;
      }

      await stopClient();

      const serverOptions: ServerOptions = () =>
        spawnDigestifServer({
          digestifPath: resolved.digestifPath,
          env: resolved.env,
          log,
        });

      const clientOptions: LanguageClientOptions = {
        documentSelector: DIGESTIF_DOCUMENT_SELECTOR,
        outputChannel: output,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        // Prevent DefaultErrorHandler restart storms (each failed restart called stop() → uncaught).
        errorHandler: {
          error: () => ({ action: ErrorAction.Shutdown, handled: true }),
          closed: () => ({
            action: CloseAction.DoNotRestart,
            message: 'Digestif language server connection closed.',
            handled: true,
          }),
        },
        // Library still void-stops on false; SafeLanguageClient makes that a no-op when not Running.
        initializationFailedHandler: (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          log(`[digestif] initialization failed: ${msg}`);
          return false;
        },
      };

      const next = new SafeLanguageClient(
        DIGESTIF_CLIENT_ID,
        DIGESTIF_CLIENT_NAME,
        serverOptions,
        clientOptions,
      );

      client = next;
      try {
        await next.start();
        if (gen !== generation) {
          await stopClient();
          return;
        }
        log('[digestif] language client started');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[digestif] failed to start: ${msg}`);
        void vscode.window.showWarningMessage(
          `Digestif failed to start: ${msg}. Build and SyncTeX remain available.`,
        );
        client = undefined;
        lastOk = undefined;
        try {
          if (next.state === State.Running) {
            await next.stop();
          }
        } catch {
          // ignore
        }
      }
    } finally {
      starting = false;
    }
  }

  return {
    startOrRestart,
    stop: stopClient,
    dispose: () => {
      generation += 1;
      void stopClient();
    },
    lastEnv: () => lastOk,
  };
}
