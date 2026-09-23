import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';
import { defaultLimits } from '../common/model';
import { chartOption, legendEntries, renderPdf } from '../server/render';
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

test('PDF swatches use configured series colors, including CSS color formats', () => {
  const pie = densePie('colors', 2, true);
  (pie.params.visColors as Record<string, string>)[pie.rows[0][0].text] = 'rgb(17, 34, 51)';
  const entries = legendEntries(pie, chartOption(pie, '#2457a7'));
  assert.equal(entries[0].color, '#112233');
  assert.equal(entries[1].color, '#0d9488');
});

test('Hide Legend hides heatmap and region map scales while reserving space when shown', () => {
  const heatmap = { ...panels[0], type: 'heatmap' as const, columns: ['X', 'Y', 'Count'], bucketCount: 2, rows: [[{ text: 'One', value: 'one' }, { text: 'Two', value: 'two' }, { text: '5', value: 5 }]] };
  const visibleHeatmap = chartOption(heatmap, '#2457a7');
  const hiddenHeatmap = chartOption(heatmap, '#2457a7', 540, true);
  assert.equal(visibleHeatmap.visualMap.show, true);
  assert.equal(hiddenHeatmap.visualMap.show, false);
  assert.ok(visibleHeatmap.grid.bottom > hiddenHeatmap.grid.bottom);
  const region = { ...panels[0], type: 'region_map' as const, rows: [[{ text: 'US', value: 'US' }, { text: '5', value: 5 }]] };
  const visibleRegion = chartOption(region, '#2457a7');
  const hiddenRegion = chartOption(region, '#2457a7', 540, true);
  assert.equal(visibleRegion.visualMap.show, true);
  assert.equal(hiddenRegion.visualMap.show, false);
  assert.ok(visibleRegion.series[0].bottom > hiddenRegion.series[0].bottom);
});

function densePie(key: string, count: number, donut: boolean) {
  return { key, title: donut ? 'Dense donut chart' : 'Dense pie chart', type: 'pie' as const,
    columns: ['Category', 'Requests'], bucketCount: 1, schemas: ['segment', 'metric'],
    params: { isDonut: donut, addLegend: true, labels: { show: true }, visColors: { 'Category 01 for distributed edge services and incident response queue with extended description': '#aa3377' } },
    rows: Array.from({ length: count }, (_, index) => [
      { text: index === 1 ? `Category 02 ${'averylongemailaddresswithnospaces'.repeat(5)}@example.com` : `Category ${String(index + 1).padStart(2, '0')} for distributed edge services and incident response queue with extended description`, value: index + 1 },
      { text: String(count - index), value: count - index }
    ]) };
}

async function pdfText(pdf: Buffer) {
  const doc = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  let text = '';
  for (let index = 1; index <= doc.numPages; index++) text += (await (await doc.getPage(index)).getTextContent()).items.map((item: any) => item.str).join(' ') + ' ';
  await doc.destroy();
  return text;
}

async function assertBodyTextWithinPage(pdf: Buffer) {
  const doc = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const items = (await page.getTextContent()).items as any[];
    for (const item of items) {
      if (!item.str.trim()) continue;
      const x = item.transform[4], y = item.transform[5];
      if (y > 76 && y < 688) {
        assert.ok(x >= 35 && x + item.width <= 577, `page ${pageNumber}: text extends outside the body horizontally: ${item.str}`);
      } else if (y >= 688) {
        assert.ok(/NORTHSTAR|TECHNOLOGIES|Operations|intelligence/.test(item.str), `page ${pageNumber}: body text entered the header: ${item.str}`);
      }
    }
  }
  await doc.destroy();
}

test('dense full-width and two-column legends wrap, paginate, and stay as PDF text', async () => {
  const fixture = structuredClone(run);
  const pie = densePie('dense-pie', 32, false), donut = densePie('dense-donut', 24, true);
  const before = structuredClone(fixture);
  await mkdir('target', { recursive: true });
  for (const layout of [1, 2] as const) {
    fixture.report.sections = [{ id: `dense-${layout}`, kind: 'panels', columns: layout, sources: layout === 1 ? ['dense-pie'] : ['dense-pie', 'dense-donut'] }];
    const result = await renderPdf(fixture, [pie, donut], defaultLimits);
    assert.ok(result.pages > 1, `layout ${layout} should paginate the legend`);
    const text = await pdfText(result.pdf);
    const normalized = text.replace(/\s+/g, ' ');
    for (let index = 1; index <= 32; index++) {
      const count = normalized.match(new RegExp(`Category ${String(index).padStart(2, '0')}\\b`, 'g'))?.length ?? 0;
      assert.equal(count, layout === 2 && index <= 24 ? 2 : 1, `layout ${layout}, category ${index}`);
    }
    assert.match(normalized, /extended description/);
    assert.ok(text.replace(/\s+/g, '').includes(`${'averylongemailaddresswithnospaces'.repeat(5)}@example.com`));
    const pdf = await PDFDocument.load(result.pdf);
    const images = [...pdf.context.enumerateIndirectObjects()].filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    assert.equal(images.length, 0);
    await assertBodyTextWithinPage(result.pdf);
    await writeFile(`target/dense-legend-${layout === 1 ? 'full' : 'two-column'}.pdf`, result.pdf);
  }
  fixture.report.sections = before.report.sections;
  assert.deepEqual(fixture, before);
});

test('section hideLegend removes PDF legend without changing source visualization settings', async () => {
  const fixture = structuredClone(run);
  const pie = densePie('dense-pie', 4, true);
  const dense = densePie('dense-hidden', 24, true);
  assert.equal(chartOption(dense, '#2457a7', 261, true).series[0].label.show, true);
  assert.equal(chartOption(dense, '#2457a7', 261, false).series[0].label.show, false);
  fixture.report.sections = [{ id: 'hidden', kind: 'panels', columns: 1, sources: ['dense-pie'], hideLegend: true }];
  const sourceParams = structuredClone(pie.params);
  const result = await renderPdf(fixture, [pie], defaultLimits);
  const text = await pdfText(result.pdf);
  assert.doesNotMatch(text, /extended description/);
  assert.deepEqual(pie.params, sourceParams);
});

test('two-column map and heatmap keep visible color scales inside their chart areas', async () => {
  const fixture = structuredClone(run);
  fixture.report.sections = [{ id: 'scales', kind: 'panels', columns: 2, sources: ['regions', 'heat'] }];
  const regions = { ...panels[0], key: 'regions', title: 'Regional volume', type: 'region_map' as const, rows: [
    [{ text: 'US', value: 'US' }, { text: '50', value: 50 }],
    [{ text: 'CA', value: 'CA' }, { text: '25', value: 25 }]
  ] };
  const heat = { ...panels[0], key: 'heat', title: 'Activity by day and tier', type: 'heatmap' as const, columns: ['Day', 'Tier', 'Count'], bucketCount: 2, rows: [
    [{ text: 'Mon', value: 'Mon' }, { text: 'Core', value: 'Core' }, { text: '10', value: 10 }],
    [{ text: 'Tue', value: 'Tue' }, { text: 'Core', value: 'Core' }, { text: '20', value: 20 }],
    [{ text: 'Mon', value: 'Mon' }, { text: 'Edge', value: 'Edge' }, { text: '5', value: 5 }],
    [{ text: 'Tue', value: 'Tue' }, { text: 'Edge', value: 'Edge' }, { text: '15', value: 15 }]
  ] };
  const result = await renderPdf(fixture, [regions, heat], defaultLimits);
  await writeFile('target/legend-scales.pdf', result.pdf);
  assert.equal(result.pages, 1);
  await assertBodyTextWithinPage(result.pdf);
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
