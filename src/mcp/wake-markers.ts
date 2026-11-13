// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (wake marker)
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const key = (value: string) => createHash('sha256').update(value).digest('hex');

/** Per-project and per-session markers shared by the server and wake hook. */
export class WakeMarkers {
  constructor(private readonly dataDir: string, private readonly projectRoot: string) {}

  private folder(session: string): string {
    return path.join(this.dataDir, 'wake', key(this.projectRoot), key(session));
  }

  private taskFolder(session: string, task: string): string {
    return path.join(this.folder(session), key(task));
  }

  start(session: string, task: string): void {
    const folder = this.folder(session);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temp = path.join(folder, `${randomUUID()}.tmp`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      writeFileSync(path.join(temp, 'owner'), String(process.pid), { mode: 0o600 });
      renameSync(temp, this.taskFolder(session, task));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }

  finish(session: string, task: string, notice: string): void {
    const folder = this.taskFolder(session, task);
    const temp = path.join(folder, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, notice, { mode: 0o600 });
      renameSync(temp, path.join(folder, 'done'));
    } catch {
      // A missing folder means collection already consumed it.
    } finally { rmSync(temp, { force: true }); }
  }

  clear(session: string, task: string): void {
    rmSync(this.taskFolder(session, task), { recursive: true, force: true });
  }

  read(session: string): { pending: boolean; notice: string | undefined } {
    const folder = this.folder(session);
    let names: string[];
    try { names = readdirSync(folder).filter((name) => /^[a-f0-9]{64}$/.test(name)); }
    catch { return { pending: false, notice: undefined }; }
    let pending = false;
    let notice: string | undefined;
    for (const name of names) {
      const taskFolder = path.join(folder, name);
      if (notice !== undefined) { pending = true; continue; }
      const claimed = path.join(taskFolder, `${randomUUID()}.claim`);
      try {
        renameSync(path.join(taskFolder, 'done'), claimed);
        notice = readFileSync(claimed, 'utf8');
        rmSync(taskFolder, { recursive: true, force: true });
      } catch {
        // Drop an orphan left by a server killed before it could publish a result.
        try {
          const pid = Number(readFileSync(path.join(taskFolder, 'owner'), 'utf8'));
          if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid owner');
          try { process.kill(pid, 0); pending = true; }
          catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EPERM') pending = true;
            else rmSync(taskFolder, { recursive: true, force: true });
          }
        } catch { /* An absent or invalid entry is ignored. */ }
      }
    }
    return { pending, notice };
  }
}

/** Renew the Stop hook before Claude's hook timeout while a child is still live. */
export async function waitForWake(markers: WakeMarkers, session: string, renewalMs = 55 * 60_000, pollMs = 250): Promise<string | undefined> {
  const started = Date.now();
  while (true) {
    const { pending, notice } = markers.read(session);
    if (notice !== undefined) return notice;
    if (!pending) return undefined;
    if (Date.now() - started >= renewalMs) return 'Subzero tasks are still running. Keep waiting for their results before using them.';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
