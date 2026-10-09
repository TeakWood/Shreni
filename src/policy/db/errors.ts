/** Shreni's schema isn't where this process needs it; the message says what to run. */
export class ShreniSchemaBehind extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShreniSchemaBehind';
  }
}
