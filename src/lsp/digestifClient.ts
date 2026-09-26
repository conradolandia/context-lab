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
import { resolveBootstrapPath, resolveDigestifLaunch } from './digestifLaunch';
import {
  afterDigestifFailure,
  afterDigestifSettingsChange,
  shouldAttemptDigestifStart,
  type DigestifStartPolicy,
} from './digestifLifecycle';
import {
  DIGESTIF_START_TIMEOUT_MS,
  preferDigestifError,
  spawnDigestifServer,
  withTimeout,
} from './digestifProcess';

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
  /**
   * Fire-and-forget start. Never await this from build/preview/SyncTeX.
   * After one failure, stays off until digestif settings change or reload.
   */
  scheduleStart(): void;
  /** Settings changed: clear give-up and schedule again (still fire-and-forget). */
  onSettingsChanged(): void;
  stop(): Promise<void>;
  dispose(): void;
  lastEnv(): DigestifEnvOk | undefined;
}

/**
 * LanguageClient that never throws from stop()/dispose() when not Running.
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
 * DigestiF LanguageClient manager. Startup is always fire-and-forget and must
 * never delay build, preview, or SyncTeX. One failed attempt disables further
 * retries until settings change or the window reloads.
 */
export function createDigestifClient(options: {
  output: vscode.OutputChannel;
  extensionPath: string;
  /** BUILD_ID string for logs (so Sir can see which build is running). */
  buildId: string;
}): DigestifClientHandle {
  const { output, extensionPath, buildId } = options;
  const log = (line: string) => {
    output.appendLine(line);
  };
  let client: SafeLanguageClient | undefined;
  let lastOk: DigestifEnvOk | undefined;
  let starting = false;
  let generation = 0;
  let policy: DigestifStartPolicy = { enabled: true, failedOnce: false };
  const bufferRef: { current: { stdout: string; stderr: string } | undefined } = {
    current: undefined,
  };

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

  function giveUp(reason: string): void {
    policy = afterDigestifFailure(policy);
    log(`[digestif] BUILD_ID=${buildId} giving up for this window: ${reason}`);
    log(
      '[digestif] Build/SyncTeX are unaffected. Fix DigestiF (prefer luarocks), ' +
        'change context.digestifPath / context.digestif.enabled, or reload the window to retry. ' +
        'Or disable our client and use Marketplace DigestiF.',
    );
  }

  async function startOnce(): Promise<void> {
    if (starting) {
      return;
    }
    if (!shouldAttemptDigestifStart(policy)) {
      return;
    }
    starting = true;
    const gen = ++generation;
    bufferRef.current = undefined;
    try {
      const cfg = vscode.workspace.getConfiguration('context');
      const enabled = cfg.get<boolean>('digestif.enabled', true);
      policy = { ...policy, enabled };
      if (!enabled) {
        log(`[digestif] BUILD_ID=${buildId} disabled (context.digestif.enabled=false)`);
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
      const bootstrapPath = resolveBootstrapPath(extensionPath);
      const resolved = buildDigestifEnv({
        root,
        digestifPath: digestifPathSetting || undefined,
        bootstrapPath,
      });

      if (!resolved.ok) {
        lastOk = undefined;
        await stopClient();
        log(`[digestif] BUILD_ID=${buildId} ${resolved.message}`);
        giveUp(resolved.message);
        void vscode.window.showWarningMessage(
          `DigestiF unavailable (BUILD_ID=${buildId}): ${resolved.message.split(/\r?\n/)[0]}. ` +
            `Build and SyncTeX still work.`,
        );
        return;
      }

      if (gen !== generation) {
        return;
      }

      lastOk = resolved;
      log(`[digestif] BUILD_ID=${buildId} source=${resolved.source}`);
      log(
        `[digestif] root=${resolved.root}  context=${contextBin || '(n/a)'}  ` +
          `mtxrun=${mtxrunBin || '(n/a)'}  digestif=${resolved.digestifPath}`,
      );
      log(
        `[digestif] xml=${resolved.interfaceXmlPath}  ` +
          `DIGESTIF_TEXMF=${resolved.texmfDirs.join(process.platform === 'win32' ? ';' : ':')}`,
      );
      if (resolved.luametatex) {
        log(`[digestif] luametatex=${resolved.luametatex}`);
      }

      const launch = resolveDigestifLaunch({
        digestifPath: resolved.digestifPath,
        source: resolved.source,
        root: resolved.root,
        luametatex: resolved.luametatex,
        texlua: resolved.texlua,
        bootstrapPath,
        digestifHome: resolved.digestifHome,
      });
      log(`[digestif] launch method=${launch.method} — ${launch.detail}`);
      log(
        `[digestif] spawn argv: ${JSON.stringify([launch.command, ...launch.args, '--verbose'])}`,
      );

      await stopClient();

      const serverOptions: ServerOptions = async () => {
        const spawned = await spawnDigestifServer({
          launch,
          env: resolved.env,
          log,
        });
        bufferRef.current = spawned.buffers;
        return spawned.process;
      };

      const clientOptions: LanguageClientOptions = {
        documentSelector: DIGESTIF_DOCUMENT_SELECTOR,
        outputChannel: output,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        errorHandler: {
          error: () => ({ action: ErrorAction.Shutdown, handled: true }),
          closed: () => ({
            action: CloseAction.DoNotRestart,
            message: 'DigestiF language server connection closed.',
            handled: true,
          }),
        },
        initializationFailedHandler: (error) => {
          const msg = preferDigestifError(error, bufferRef.current);
          log(`[digestif] BUILD_ID=${buildId} initialization failed: ${msg}`);
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
        log(
          `[digestif] BUILD_ID=${buildId} starting LanguageClient ` +
            `(initialize timeout ${DIGESTIF_START_TIMEOUT_MS}ms; does not block build)…`,
        );
        await withTimeout(
          next.start(),
          DIGESTIF_START_TIMEOUT_MS,
          `DigestiF LSP initialize timed out after ${DIGESTIF_START_TIMEOUT_MS}ms`,
        );
        if (gen !== generation) {
          await stopClient();
          return;
        }
        log(`[digestif] BUILD_ID=${buildId} language client started`);
      } catch (err) {
        const msg = preferDigestifError(err, bufferRef.current);
        log(`[digestif] BUILD_ID=${buildId} failed to start: ${msg}`);
        giveUp(msg.split(/\r?\n/)[0] ?? msg);
        void vscode.window.showWarningMessage(
          `DigestiF failed (BUILD_ID=${buildId}): ${msg.split(/\r?\n/)[0] ?? msg}. ` +
            `Build and SyncTeX remain available.`,
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

  function scheduleStart(): void {
    if (!shouldAttemptDigestifStart(policy)) {
      return;
    }
    void startOnce();
  }

  function onSettingsChanged(): void {
    const cfg = vscode.workspace.getConfiguration('context');
    const enabled = cfg.get<boolean>('digestif.enabled', true);
    policy = afterDigestifSettingsChange(policy, enabled);
    generation += 1;
    void stopClient().then(() => {
      scheduleStart();
    });
  }

  return {
    scheduleStart,
    onSettingsChanged,
    stop: stopClient,
    dispose: () => {
      generation += 1;
      policy = afterDigestifFailure(policy);
      void stopClient();
    },
    lastEnv: () => lastOk,
  };
}
