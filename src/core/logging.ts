export interface BridgeLogger {
  info(event: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(event: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export const NULL_LOGGER: BridgeLogger = {
  info: () => undefined,
  error: () => undefined
};
