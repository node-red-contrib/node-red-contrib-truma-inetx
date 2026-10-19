import { connectToTruma, disconnectQuietly, type ConnectOptions, type TrumaSession } from './ble.js';
import { TrumaProtocol, type TrumaProtocolOptions } from './protocol.js';

/** Optional retained session. Callers must serialize requests and scheduled cleanup. */
export class TrumaConnection {
  private session?: TrumaSession;
  private protocol?: TrumaProtocol;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private key = '';

  constructor(
    private readonly idleMs: number,
    private readonly schedule: (operation: () => Promise<void>) => Promise<void>
  ) {
    if (!Number.isFinite(idleMs) || idleMs < 1000 || idleMs > 86400000) throw new Error('Idle timeout must be between one second and 24 hours.');
  }

  async acquire(options: ConnectOptions, protocolOptions?: TrumaProtocolOptions) {
    this.cancelTimer();
    const key = JSON.stringify({ ...options, logger: undefined, protocol: { ...protocolOptions, logger: undefined } });
    if (this.key !== key || this.session?.peripheral.state !== 'connected') await this.close();
    if (!this.session) {
      this.session = await connectToTruma(options);
      this.key = key;
      try { this.protocol = new TrumaProtocol(this.session.characteristics, protocolOptions); }
      catch (error) { await this.close(); throw error; }
    }
    this.protocol!.clearCollectedResponses();
    return { session: this.session, protocol: this.protocol! };
  }

  async release(success: boolean) {
    if (!success) { await this.close(); return; }
    this.cancelTimer();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      void this.schedule(async () => {
        if (generation === this.generation) await this.close();
      }).catch(() => {});
    }, this.idleMs);
    this.timer.unref();
  }

  async close() {
    this.cancelTimer();
    const session = this.session;
    this.session = undefined;
    this.protocol?.close();
    this.protocol = undefined;
    await disconnectQuietly(session?.peripheral);
  }

  private cancelTimer() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
