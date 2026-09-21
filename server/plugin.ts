import { PlatformAdapter } from './platform';
import { OpenSearchStore } from './store';
import { SmtpMailer } from './mail';
import { Runner } from './runner';
import { threadedRender } from './threaded_renderer';
import { registerRoutes, Services } from './routes';
import { ReportError } from '../common/model';

export class BetterReportsPlugin {
  private services?: Services;
  private startError?: Error;
  private config: any;
  private stopped = false;
  constructor(private context: any) {}
  async setup(core: any, deps: any) {
    this.config = await new Promise(resolve => { const subscription = this.context.config.create().subscribe((value: any) => { resolve(value); queueMicrotask(() => subscription.unsubscribe()); }); });
    if (this.context.env.packageInfo.version !== '3.8.0') throw new Error('BetterReports requires OpenSearch Dashboards 3.8.0 exactly.');
    if (core.workspace.isWorkspaceEnabled()) throw new Error('BetterReports v1 requires Security tenants with Workspaces disabled.');
    const securityConfig: any = await new Promise(resolve => { const subscription = deps.securityDashboards.config$.subscribe((value: any) => { resolve(value); queueMicrotask(() => subscription.unsubscribe()); }); });
    if (!securityConfig.multitenancy.enabled || securityConfig.multitenancy.enable_aggregation_view) throw new Error('BetterReports v1 requires Security multitenancy with enable_aggregation_view: false.');
    core.capabilities.registerProvider(() => ({ betterReports: { show: true } }));
    registerRoutes(core.http.createRouter(), async () => {
      if (this.services) return this.services;
      throw new ReportError('NOT_READY', this.startError ? 'BetterReports initialization failed. See the server log.' : 'BetterReports is initializing.', 503);
    }, message => this.context.logger.get().warn(message));
    return {};
  }
  start(core: any, deps: any) {
    const store = new OpenSearchStore(core.opensearch.client.asInternalUser);
    const platform = new PlatformAdapter(core, deps.data, { username: this.config.worker.username, password: process.env[this.config.worker.passwordEnv] ?? '' }, this.config.limits);
    const mailer = new SmtpMailer({ ...this.config.smtp, password: process.env[this.config.smtp.passwordEnv] ?? '' });
    const runner = new Runner(store, platform, threadedRender, mailer, this.config.limits, message => this.context.logger.get().warn(message));
    void store.init().then(() => { if (this.stopped) { runner.stop(); return; } this.services = { store, platform, runner, adminRoles: this.config.adminRoles }; runner.start(); }).catch(error => { this.startError = error; this.context.logger.get().error('BetterReports storage initialization failed. Verify internal-user index permissions.'); });
    return {};
  }
  stop() { this.stopped = true; this.services?.runner.stop(); }
}
