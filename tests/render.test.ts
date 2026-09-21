import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';
import { defaultLimits } from '../common/model';
import { chartOption, renderPdf } from '../server/render';
import { demoFixture, panels, run } from './fixtures';

test('renders multipage Letter PDF with embedded fonts and no screenshot images', async () => {
  const fixture = demoFixture(); const result = await renderPdf(fixture.run, fixture.panels, defaultLimits);
  const doc = await PDFDocument.load(result.pdf); assert.ok(result.pages >= 3);
  for (const page of doc.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  let fonts = 0, images = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images++;
    if (object instanceof PDFDict && object.has(PDFName.of('FontFile2'))) fonts++;
  }
  assert.equal(images, 0); assert.ok(fonts > 0);
});
test('page and byte limits fail explicitly', async () => {
  const fixture = demoFixture();
  await assert.rejects(renderPdf(fixture.run, fixture.panels, { ...defaultLimits, pages: 1 }), /exceeds 1 pages/);
  await assert.rejects(renderPdf(run, panels, { ...defaultLimits, bytes: 100 }), /attachment limit/);
});
test('chart series retain numeric data and vector SSR settings', () => {
  const option = chartOption(panels[0], '#2457a7'); assert.equal(option.animation, false); assert.deepEqual(option.series[0].data, [12000, 16000, 14000, 25000, 22000, 29000, 31000]);
});

test('accepts exactly 20 Letter pages and rejects the 21st without truncation', async () => {
  const fixture = structuredClone(run); fixture.report.sources = []; fixture.report.sections = [];
  for (let page = 1; page <= 20; page++) {
    if (page > 1) fixture.report.sections.push({ id: `break-${page}`, kind: 'pageBreak' });
    fixture.report.sections.push({ id: `page-${page}`, kind: 'text', text: `Acceptance page ${page}`, style: 'body', bold: false, alignment: 'left' });
  }
  const pdf = await renderPdf(fixture, [], defaultLimits); assert.equal(pdf.pages, 20);
  fixture.report.sections.push({ id: 'break-21', kind: 'pageBreak' }, { id: 'page-21', kind: 'text', text: 'This must fail', style: 'body', bold: false, alignment: 'left' });
  await assert.rejects(renderPdf(fixture, [], defaultLimits), /exceeds 20 pages/);
});
