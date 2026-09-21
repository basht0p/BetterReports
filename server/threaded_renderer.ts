import { Worker } from 'worker_threads';
import { join } from 'path';
import { Limits, PanelData, ReportError, Run } from '../common/model';
export function threadedRender(run: Run, panels: PanelData[], limits: Limits, signal: AbortSignal): Promise<{ pdf: Buffer; pages: number }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'render_worker.js'), { workerData: { run, panels, limits }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const abort = () => { void worker.terminate(); reject(new ReportError('RUN_TIMEOUT', 'Report generation was cancelled or exceeded its deadline.')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', result => { signal.removeEventListener('abort', abort); if (result.error) reject(new ReportError(result.error.code, result.error.message)); else resolve({ pdf: Buffer.from(result.pdf), pages: result.pages }); void worker.terminate(); });
    worker.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    worker.once('exit', code => { signal.removeEventListener('abort', abort); if (code !== 0) reject(new ReportError('RENDER_FAILED', 'The PDF renderer stopped unexpectedly.', 500, true)); });
  });
}
