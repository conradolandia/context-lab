import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Toolchain } from '../toolchain/discover';
import { runContextBuild, type BuildResult } from './compiler';
import { clearBuildDiagnostics, publishBuildDiagnostics } from './buildDiagnostics';

export type BuildTrigger = 'command' | 'onSave' | 'queued';

export interface BuildControllerDeps {
  output: vscode.OutputChannel;
  buildDiagnostics: vscode.DiagnosticCollection;
  resolveToolchain: () => Toolchain;
  resolveRoot: (activePath?: string) => { rootFile: string; rule: string } | undefined;
  activeTexPath: () => string | undefined;
  onBuildStart: () => void;
  onBuildEnd: (ok: boolean) => void;
  onBuildSuccess: (result: BuildResult) => Promise<void>;
  buildId: string;
  /** Status bar item updated with build state / last duration. */
  buildStatus: vscode.StatusBarItem;
}

/**
 * Single-flight ConTeXt builds with one coalesced follow-up.
 *
 * - Manual command while busy → information "already running".
 * - onSave while busy → queue at most one follow-up (no "already running").
 * - Rapid saves coalesce to a single queued build.
 */
export class BuildController {
  private building = false;
  private queueFollowUp = false;
  private lastDurationMs: number | undefined;
  private disposed = false;

  constructor(private readonly deps: BuildControllerDeps) {
    this.updateStatusIdle();
  }

  get isBuilding(): boolean {
    return this.building;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Manual Build and Preview command. */
  requestCommandBuild(): void {
    if (this.building) {
      void vscode.window.showInformationMessage('A ConTeXt build is already running.');
      return;
    }
    void this.runBuild('command');
  }

  /** Save-triggered build when `context.build.onSave` is true. */
  requestSaveBuild(): void {
    if (this.building) {
      this.queueFollowUp = true;
      this.deps.buildStatus.text = 'ConTeXt build: running (+queued)';
      return;
    }
    void this.runBuild('onSave');
  }

  private updateStatusIdle(): void {
    if (this.lastDurationMs != null) {
      const sec = (this.lastDurationMs / 1000).toFixed(1);
      this.deps.buildStatus.text = `ConTeXt build: idle (${sec}s)`;
      this.deps.buildStatus.tooltip = `Last build took ${this.lastDurationMs} ms`;
    } else {
      this.deps.buildStatus.text = 'ConTeXt build: idle';
      this.deps.buildStatus.tooltip = 'No build yet';
    }
  }

  private async runBuild(trigger: BuildTrigger): Promise<void> {
    if (this.disposed || this.building) {
      return;
    }

    const active = this.deps.activeTexPath();
    const root = this.deps.resolveRoot(active);
    if (!root) {
      if (trigger === 'command') {
        void vscode.window.showErrorMessage('Open a ConTeXt / TeX source file to build.');
      }
      return;
    }

    let toolchain: Toolchain;
    try {
      toolchain = this.deps.resolveToolchain();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (trigger === 'command') {
        void vscode.window.showErrorMessage(msg);
      }
      this.deps.output.appendLine(msg);
      return;
    }

    this.building = true;
    this.queueFollowUp = false;
    clearBuildDiagnostics(this.deps.buildDiagnostics);
    this.deps.onBuildStart();
    this.deps.buildStatus.text = 'ConTeXt build: running…';
    this.deps.buildStatus.tooltip = `Building ${root.rootFile}`;

    const output = this.deps.output;
    output.clear();
    if (trigger === 'command' || trigger === 'onSave') {
      output.show(true);
    }
    output.appendLine(
      `ConTeXt SyncTeX BUILD_ID=${this.deps.buildId} (build does not wait on DigestiF)`,
    );
    output.appendLine(
      `Building root=${root.rootFile} (rule=${root.rule}) trigger=${trigger}` +
        (active && active !== root.rootFile ? `; active=${active}` : ''),
    );

    const started = Date.now();
    let ok = false;
    try {
      const result = await runContextBuild(toolchain, root.rootFile, { output });
      const logPath = root.rootFile.replace(/\.[^.]+$/, '.log');
      let logText = '';
      try {
        if (fs.existsSync(logPath)) {
          logText = fs.readFileSync(logPath, 'utf8');
        }
      } catch {
        logText = '';
      }
      const parsed = publishBuildDiagnostics(this.deps.buildDiagnostics, {
        cwd: path.dirname(root.rootFile),
        rootFile: root.rootFile,
        stdout: result.stdout,
        stderr: result.stderr,
        logText,
      });
      output.appendLine(
        `[diagnostics] ${parsed.length} issue(s) from console/log` +
          (parsed.some((d) => d.severity === 'error') ? ' (errors present)' : ''),
      );

      if (result.exitCode !== 0) {
        void vscode.window.showErrorMessage(
          `ConTeXt build failed (exit ${result.exitCode}). See ConTeXt output.`,
        );
      } else {
        ok = true;
        await this.deps.onBuildSuccess(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(msg);
      void vscode.window.showErrorMessage(`Build error: ${msg}`);
    } finally {
      this.lastDurationMs = Date.now() - started;
      this.building = false;
      this.deps.onBuildEnd(ok);
      this.updateStatusIdle();
      if (this.queueFollowUp) {
        this.queueFollowUp = false;
        void this.runBuild('queued');
      }
    }
  }
}
