import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Toolchain } from '../toolchain/discover';
import { runContextBuild, type BuildResult } from './compiler';
import { clearBuildDiagnostics, publishBuildDiagnostics } from './buildDiagnostics';
import {
  preserveFocusForBuildTrigger,
  type BuildTrigger,
} from './buildTrigger';
import { killProcessTree } from './killProcessTree';

export type { BuildTrigger } from './buildTrigger';
export { preserveFocusForBuildTrigger } from './buildTrigger';

const BUILD_RUNNING_CONTEXT = 'context.buildRunning';

export interface BuildControllerDeps {
  output: vscode.OutputChannel;
  buildDiagnostics: vscode.DiagnosticCollection;
  resolveToolchain: () => Toolchain;
  resolveRoot: (activePath?: string) => { rootFile: string; rule: string } | undefined;
  activeTexPath: () => string | undefined;
  onBuildStart: () => void;
  onBuildEnd: (ok: boolean) => void;
  onBuildSuccess: (result: BuildResult, trigger: BuildTrigger) => Promise<void>;
  buildId: string;
  /** Status bar item updated with build state / last duration. */
  buildStatus: vscode.StatusBarItem;
}

/**
 * Single-flight ConTeXt builds with one coalesced follow-up.
 *
 * - Manual command while busy → information "already running" (+ cancel hint).
 * - onSave while busy → queue at most one follow-up (no "already running").
 * - Rapid saves coalesce to a single queued build.
 * - Cancel clears the active process tree, skips PDF refresh, and drops the queue.
 */
export class BuildController {
  private building = false;
  private queueFollowUp = false;
  private cancelRequested = false;
  private activeChild: ChildProcess | undefined;
  private lastDurationMs: number | undefined;
  private disposed = false;

  constructor(private readonly deps: BuildControllerDeps) {
    this.updateStatusIdle();
    void vscode.commands.executeCommand('setContext', BUILD_RUNNING_CONTEXT, false);
  }

  get isBuilding(): boolean {
    return this.building;
  }

  dispose(): void {
    this.disposed = true;
    if (this.building && this.activeChild) {
      this.cancelRequested = true;
      this.queueFollowUp = false;
      void killProcessTree(this.activeChild);
    }
    void vscode.commands.executeCommand('setContext', BUILD_RUNNING_CONTEXT, false);
  }

  /** Manual Build and Preview command. Optional absolute root overrides resolveRoot. */
  requestCommandBuild(overrideRootFile?: string): void {
    if (this.building) {
      void vscode.window.showInformationMessage(
        'A ConTeXt build is already running. Use "ConTeXt: Cancel Build" to stop it.',
      );
      return;
    }
    void this.runBuild('command', overrideRootFile);
  }

  /** Save-triggered build when `context.build.onSave` is true. */
  requestSaveBuild(): void {
    if (this.building) {
      this.queueFollowUp = true;
      this.deps.buildStatus.text = 'ConTeXt build: running (+queued)';
      this.deps.buildStatus.tooltip =
        `Building (follow-up queued) — click to cancel`;
      this.deps.buildStatus.command = 'context.cancelBuild';
      return;
    }
    void this.runBuild('onSave');
  }

  /**
   * Cancel the active ConTeXt process tree. Clears single-flight and any
   * queued on-save follow-up. No PDF refresh on cancel.
   */
  cancelBuild(): void {
    if (!this.building || !this.activeChild) {
      void vscode.window.showInformationMessage('No ConTeXt build is running.');
      return;
    }
    if (this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.queueFollowUp = false;
    this.deps.buildStatus.text = 'ConTeXt build: cancelling…';
    this.deps.buildStatus.tooltip = 'Cancelling build…';
    this.deps.buildStatus.command = undefined;
    void killProcessTree(this.activeChild);
  }

  private updateStatusIdle(): void {
    this.deps.buildStatus.command = undefined;
    if (this.lastDurationMs != null) {
      const sec = (this.lastDurationMs / 1000).toFixed(1);
      this.deps.buildStatus.text = `ConTeXt build: idle (${sec}s)`;
      this.deps.buildStatus.tooltip = `Last build took ${this.lastDurationMs} ms`;
    } else {
      this.deps.buildStatus.text = 'ConTeXt build: idle';
      this.deps.buildStatus.tooltip = 'No build yet';
    }
  }

  private setBuildingStatus(rootFile: string): void {
    this.deps.buildStatus.text = 'ConTeXt build: running…';
    this.deps.buildStatus.tooltip = `Building ${rootFile} — click to cancel`;
    this.deps.buildStatus.command = 'context.cancelBuild';
  }

  private async runBuild(trigger: BuildTrigger, overrideRootFile?: string): Promise<void> {
    if (this.disposed || this.building) {
      return;
    }

    const active = this.deps.activeTexPath();
    const root = overrideRootFile
      ? { rootFile: overrideRootFile, rule: 'projectView:node' }
      : this.deps.resolveRoot(active);
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
    this.cancelRequested = false;
    clearBuildDiagnostics(this.deps.buildDiagnostics);
    this.deps.onBuildStart();
    this.setBuildingStatus(root.rootFile);
    void vscode.commands.executeCommand('setContext', BUILD_RUNNING_CONTEXT, true);

    const output = this.deps.output;
    output.clear();
    if (trigger === 'command' || trigger === 'onSave') {
      output.show(true);
    }
    output.appendLine(
      `ConTeXt Tools BUILD_ID=${this.deps.buildId} (build does not wait on DigestiF)`,
    );
    output.appendLine(
      `Building root=${root.rootFile} (rule=${root.rule}) trigger=${trigger}` +
        (active && active !== root.rootFile ? `; active=${active}` : ''),
    );

    const started = Date.now();
    let ok = false;
    let wasCancelled = false;
    try {
      const handle = runContextBuild(toolchain, root.rootFile, { output });
      this.activeChild = handle.child;
      const result = await handle.promise;
      wasCancelled = this.cancelRequested;

      if (wasCancelled) {
        output.appendLine('[cancelled]');
      } else {
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
          await this.deps.onBuildSuccess(result, trigger);
        }
      }
    } catch (err) {
      wasCancelled = this.cancelRequested;
      if (wasCancelled) {
        output.appendLine('[cancelled]');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(msg);
        void vscode.window.showErrorMessage(`Build error: ${msg}`);
      }
    } finally {
      this.lastDurationMs = Date.now() - started;
      this.activeChild = undefined;
      this.cancelRequested = false;
      this.building = false;
      void vscode.commands.executeCommand('setContext', BUILD_RUNNING_CONTEXT, false);
      this.deps.onBuildEnd(ok);
      this.updateStatusIdle();
      if (wasCancelled) {
        this.queueFollowUp = false;
      } else if (this.queueFollowUp) {
        this.queueFollowUp = false;
        void this.runBuild('queued');
      }
    }
  }
}
