declare module '@abandonware/noble' {
  import type { EventEmitter } from 'node:events';

  export interface NobleAdvertisement {
    localName?: string;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
  }

  export interface NobleCharacteristic extends EventEmitter {
    uuid: string;
    properties?: string[];
    read(callback: (error: Error | null, data: Buffer) => void): void;
    write(data: Buffer, withoutResponse: boolean, callback: (error: Error | null) => void): void;
    subscribe(callback: (error: Error | null) => void): void;
  }

  export interface NoblePeripheral extends EventEmitter {
    id: string;
    uuid?: string;
    address?: string;
    addressType?: string;
    connectable?: boolean;
    rssi?: number;
    state?: string;
    advertisement?: NobleAdvertisement;
    connect(callback: (error?: Error | string | null) => void): void;
    cancelConnect?(): void;
    disconnect(callback: (error?: Error | null) => void): void;
    discoverAllServicesAndCharacteristics(
      callback: (error: Error | null, services: unknown[], characteristics: NobleCharacteristic[]) => void
    ): void;
  }

  export interface NobleBindings {
    cancelConnect?(peripheralUuid: string): void;
    disconnect?(peripheralUuid: string): void;
  }

  export interface Noble extends EventEmitter {
    state: string;
    _bindings?: NobleBindings;
    startScanning(services: string[], allowDuplicates: boolean, callback: (error?: Error) => void): void;
    stopScanning(): void;
    on(event: 'discover', listener: (peripheral: NoblePeripheral) => void): this;
    on(event: 'stateChange', listener: (state: string) => void): this;
    once(event: 'scanStop', listener: () => void): this;
    removeListener(event: 'discover', listener: (peripheral: NoblePeripheral) => void): this;
    removeListener(event: 'stateChange', listener: (state: string) => void): this;
    removeListener(event: 'scanStop', listener: () => void): this;
    removeAllListeners(event?: string): this;
  }

  const noble: Noble;
  export default noble;
}
