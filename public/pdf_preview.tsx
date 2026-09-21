import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';

export function PdfPreview({ bytes, workerUrl, filename, stale }: { bytes?: Uint8Array; workerUrl: string; filename: string; stale: boolean }) {
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy>();
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!bytes) return;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const loading = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    let disposed = false;
    loading.promise.then(pdf => { if (!disposed) { setDocument(pdf); setPage(1); setError(''); } }).catch(e => { if (!disposed) setError(String(e.message)); });
    return () => { disposed = true; void loading.destroy(); setDocument(undefined); };
  }, [bytes, workerUrl]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let task: pdfjs.RenderTask | undefined, disposed = false;
    document.getPage(page).then(pdfPage => {
      if (disposed || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom * 1.15 }), outputScale = window.devicePixelRatio || 1;
      canvas.current.height = viewport.height * outputScale; canvas.current.width = viewport.width * outputScale;
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvasContext: canvas.current.getContext('2d')!, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0] });
      void task.promise.catch(e => { if (e.name !== 'RenderingCancelledException') setError(e.message); });
    }).catch(e => setError(e.message));
    return () => { disposed = true; task?.cancel(); };
  }, [document, page, zoom]);
  const download = () => {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/pdf' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `${filename}.pdf`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="br-preview" aria-label="Report preview">
    <div className="br-preview-toolbar"><strong>PDF preview</strong><span className="br-tag">US Letter · 8.5 × 11 in</span>
      <button onClick={download} disabled={!bytes}>Download PDF</button></div>
    {stale && bytes && <div className="br-warning">This preview reflects an earlier revision. Generate a new preview to include your changes.</div>}
    {error && <div role="alert" className="br-error">{error}</div>}
    {document && <div className="br-pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {document.numPages}</span><button disabled={page >= document.numPages} onClick={() => setPage(page + 1)}>Next</button><label>Zoom <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.5}>150%</option></select></label></div>}
    <div className="br-paper-area">{bytes ? <canvas ref={canvas} aria-label={`PDF page ${page}`} /> : <div className="br-empty"><div className="br-paper-icon">Aa</div><h2>Your report, ready for the page.</h2><p>Add report sections and generate a preview.<br />Charts stay sharp. Text stays selectable.</p></div>}</div>
  </section>;
}
