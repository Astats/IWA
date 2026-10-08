import {
  ProviderError,
  normalizeListing,
  type BackupProvider,
  type ProviderErrorCode,
  type ProviderId,
  type RemoteBackup,
} from '../provider';

type Operation = 'connect' | 'list' | 'upload' | 'download' | 'delete';

export interface FakeBackupProviderOptions {
  id?: ProviderId;
  /** Start connected (skips `connect()`). */
  connected?: boolean;
  now?: () => Date;
  /** Artificial latency per call, in ms (lets UI tests observe busy states). */
  latencyMs?: number;
}

/**
 * In-memory BackupProvider for tests and the e2e build (TEST_PLAN 3.1). Behaves like a real
 * provider: operations require a connection, ids are opaque, failures are typed, and a failed
 * upload stores nothing.
 */
export class FakeBackupProvider implements BackupProvider {
  readonly id: ProviderId;
  /** Stored files by id (inspect in tests). */
  readonly files = new Map<string, RemoteBackup & { bytes: Uint8Array }>();
  private connected: boolean;
  private nextId = 1;
  private readonly failures: Array<{ op: Operation; code: ProviderErrorCode }> = [];
  private readonly now: () => Date;
  private readonly latencyMs: number;

  constructor(options: FakeBackupProviderOptions = {}) {
    this.id = options.id ?? 'fake';
    this.connected = options.connected ?? false;
    this.now = options.now ?? (() => new Date());
    this.latencyMs = options.latencyMs ?? 0;
  }

  /** Makes the next call of `op` fail with `code` (queued; one failure per call). */
  failNext(op: Operation, code: ProviderErrorCode): this {
    this.failures.push({ op, code });
    return this;
  }

  /** Simulates the provider revoking the session (e.g. the user removed app access). */
  revoke(): void {
    this.connected = false;
  }

  /** Adds a file as if another device had uploaded it. */
  seed(name: string, bytes: Uint8Array, createdAt = this.now().toISOString()): RemoteBackup {
    const item = { id: `fake-${this.nextId++}`, name, size: bytes.length, createdAt };
    this.files.set(item.id, { ...item, bytes: bytes.slice() });
    return item;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    await this.step('connect', false);
    this.connected = true;
  }

  async list(): Promise<RemoteBackup[]> {
    await this.step('list');
    return normalizeListing(
      [...this.files.values()].map(({ id, name, size, createdAt }) => ({
        id,
        name,
        size,
        createdAt,
      })),
    );
  }

  async upload(name: string, bytes: Uint8Array): Promise<RemoteBackup> {
    await this.step('upload');
    return this.seed(name, bytes);
  }

  async download(id: string): Promise<Uint8Array> {
    await this.step('download');
    const file = this.files.get(id);
    if (!file) throw new ProviderError('NOT_FOUND');
    return file.bytes.slice();
  }

  async delete(id: string): Promise<void> {
    await this.step('delete');
    if (!this.files.delete(id)) throw new ProviderError('NOT_FOUND');
  }

  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  private async step(op: Operation, requireConnection = true): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const index = this.failures.findIndex((f) => f.op === op);
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      if (failure) {
        if (failure.code === 'AUTH_REQUIRED') this.connected = false;
        throw new ProviderError(failure.code);
      }
    }
    if (requireConnection && !this.connected) throw new ProviderError('AUTH_REQUIRED');
  }
}
