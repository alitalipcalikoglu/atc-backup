import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Database } from './db.js';
import { EventPublisher } from './events/event-publisher.js';
import { BackupService } from './domain/backup-service.js';
import { BackupApi } from './http/backup-api.js';
import { MediaClient } from './net/media-client.js';
import { BackupStore } from './store/backup-store.js';

/** Composition root: wires configuration, storage, domain and HTTP, runs the scheduler, owns the lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.events = new EventPublisher({ source: 'atc-backup', target: config.events });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.store = new BackupStore(this.db);
    this.service = new BackupService({ config, store: this.store, media: config.media ? new MediaClient(config.media) : null, events: this.events });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const app = await new BackupApi({ config, audit: this.audit, service: this.service, db: this.db, version: this.version }).build();
    this.app = app;
    this.service.logger = app.log;
    await this.service.recover();
    let ticking = false;
    const tick = () => {
      if (ticking) return;
      ticking = true;
      this.service.tick().finally(() => { ticking = false; });
    };
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => { if (this.timer) clearInterval(this.timer); this.service.stopping.abort(); },
        () => this.app?.close(),
        () => this.service.idle(),
        () => this.events.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.events.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, sources: config.sources.map((s) => s.id), intervalMin: config.schedule.intervalMin }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
    // Scheduling starts after listen so a long first backup never delays readiness.
    this.timer = setInterval(tick, config.schedule.tickMs);
    this.timer.unref();
    setImmediate(tick);
  }
}
