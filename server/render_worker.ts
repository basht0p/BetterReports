import { parentPort, workerData } from 'worker_threads';
import { renderPdf } from './render';
import { safeError } from '../common/model';
renderPdf(workerData.run, workerData.panels, workerData.limits).then(result => parentPort!.postMessage({ pdf: result.pdf, pages: result.pages })).catch(error => parentPort!.postMessage({ error: safeError(error) }));
