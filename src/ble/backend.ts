import type { TrumaSession } from '../ble.js';

export type BluetoothBackendName = 'auto' | 'bluez' | 'noble';

export interface ResolvedConnectOptions {
  namePrefix: string;
  deviceName?: string;
  deviceAddress?: string;
  scanServiceUuid: string | null;
  matchServiceUuid: string | null;
  timeoutMs: number;
  connectTimeoutMs: number;
  discoverTimeoutMs: number;
  connectRetries: number;
  logger: (message: string) => void;
}

export interface BluetoothBackend {
  name: Exclude<BluetoothBackendName, 'auto'>;
  isAvailable(logger?: (message: string) => void): Promise<boolean>;
  connect(options: ResolvedConnectOptions): Promise<TrumaSession>;
  shutdown(): Promise<void>;
}
