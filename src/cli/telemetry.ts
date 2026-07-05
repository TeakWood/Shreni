import {
  enableTelemetry,
  disableTelemetry,
  telemetryStatus,
  CONSENT_NOTICE,
} from '../telemetry/telemetry.js';

// `shreni telemetry <status|enable|disable>` — the disclosed opt-in control.
export function runTelemetry(sub: string | undefined): void {
  switch (sub) {
    case 'enable': {
      console.log(CONSENT_NOTICE);
      console.log('');
      const cfg = enableTelemetry();
      console.log('Telemetry enabled. Thank you — this is anonymous and opt-out any time.');
      console.log(`  anonymous id: ${cfg.anonymousId}`);
      const status = telemetryStatus();
      if (!status.endpoint) {
        console.log(
          `  no collector endpoint is configured, so events are written locally only:\n` +
            `    ${status.localSink}`,
        );
      }
      break;
    }
    case 'disable': {
      disableTelemetry();
      console.log('Telemetry disabled. No events will be sent.');
      break;
    }
    case 'status':
    case undefined: {
      const s = telemetryStatus();
      console.log(`Telemetry: ${s.enabled ? 'ENABLED' : 'disabled'}${s.hardOptOut ? ' (hard opt-out via env)' : ''}`);
      console.log(`  anonymous id: ${s.anonymousId ?? '(none — not yet enabled)'}`);
      console.log(`  endpoint:     ${s.endpoint ?? '(none — local sink only)'}`);
      if (!s.enabled) console.log('  enable with:  shreni telemetry enable');
      break;
    }
    default:
      console.error(`Unknown telemetry subcommand: ${sub}`);
      console.error('Usage: shreni telemetry <status|enable|disable>');
      process.exit(1);
  }
}