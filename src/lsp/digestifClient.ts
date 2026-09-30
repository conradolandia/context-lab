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
import { resolveDigestifLaunch } from './digestifLaunch';
import {
  afterDigestifFailure,
  afterDigestifSettingsChange,
  shouldAttemptDigestifStart,
  type DigestifStartPolicy,
} from './digestifLifecycle';
import {
  DIGESTIF_START_TIMEOUT_MS,
  preferDigestifError,
  withTimeout,
} from './digestifProcess';
import { normalizeOutlineSymbols } from './normalizeOutlineTitle';

export const DIGESTIF_CLIENT_ID = 'contextTools.digestif';
export const DIGESTIF_CLIENT_NAME = 'ConTeXt Tools DigestiF';

export const DIGESTIF_DOCUMENT_SELECTOR: DocumentSelector = [
  { scheme: 'file', language: 'context' },
  { scheme: 'file', language: 'tex' },
  { scheme: 'file', language: 'latex' },
  { scheme: 'untitled', language: 'context' },
  { scheme: 'untitled', language: 'tex' },
  { scheme: 'untitled', language: 'latex' },
];

export interface DigestifClientHandle {
  scheduleStart(): void;
  onSettingsChanged(): void;
  stop(): Promise<void>;
  dispose(): void;
  lastEnv(): DigestifEnvOk | undefined;
}

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
 * DigestiF manager. Fire-and-forget; never blocks build.
 * Uses its own OutputChannel (not the ConTeXt build channel).
 * LanguageClient owns the child process so stderr is logged once.
 */
export function createDigestifClient(options: {
  output: vscode.OutputChannel;
  buildId: string;
}): DigestifClientHandle {
  const { output, buildId } = options;
  const log = (line: string) => {
    output.appendLine(line);
  };
  let client: SafeLanguageClient | undefined;
  let lastOk: DigestifEnvOk | undefined;
  let starting = false;
  let generation = 0;
  let startSucceeded = false;
  let policy: DigestifStartPolicy = { enabled: true, failedOnce: false };

  async function stopClient(): Promise<void> {
    const c = client;
    client = undefined;
    startSucceeded = false;
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
      '[digestif] Build/SyncTeX are unaffected. Prefer ~/.luarocks/bin/digestif, ' +
        'set context.digestifPath, disable context.digestif.enabled, or use Marketplace DigestiF.',
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
    startSucceeded = false;
    const gen = ++generation;
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
      const resolved = buildDigestifEnv({
        root,
        digestifPath: digestifPathSetting || undefined,
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

      const launch = resolveDigestifLaunch({
        digestifPath: resolved.digestifPath,
        source: resolved.source,
      });
      const spawnArgs = [...launch.args, '--verbose'];
      log(`[digestif] launch method=${launch.method} — ${launch.detail}`);
      log(`[digestif] spawn argv: ${JSON.stringify([launch.command, ...spawnArgs])}`);

      await stopClient();

      // Let LanguageClient spawn the process so stderr is written once to our channel.
      const serverOptions: ServerOptions = {
        command: launch.command,
        args: spawnArgs,
        options: {
          env: { ...resolved.env, ...launch.envOverrides },
        },
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
          const msg = preferDigestifError(error);
          log(`[digestif] BUILD_ID=${buildId} initialization failed: ${msg}`);
          return false;
        },
        // DigestiF owns DocumentSymbol; we only clean names for Outline display.
        middleware: {
          provideDocumentSymbols: async (document, token, next) => {
            const result = await next(document, token);
            if (!result) {
              return result;
            }
            normalizeOutlineSymbols(result as import('./normalizeOutlineTitle').OutlineSymbolLike[]);
            return result;
          },
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
            `(timeout ${DIGESTIF_START_TIMEOUT_MS}ms; does not block build)…`,
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
        if (next.state !== State.Running) {
          const msg = `LanguageClient finished but state=${State[next.state] ?? next.state}`;
          log(`[digestif] BUILD_ID=${buildId} failed to start: ${msg}`);
          giveUp(msg);
          client = undefined;
          lastOk = undefined;
          return;
        }
        startSucceeded = true;
        log(`[digestif] BUILD_ID=${buildId} language client started`);
      } catch (err) {
        const msg = preferDigestifError(err);
        log(`[digestif] BUILD_ID=${buildId} failed to start: ${msg}`);
        startSucceeded = false;
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
      if (!startSucceeded && client && client.state !== State.Running) {
        client = undefined;
      }
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
