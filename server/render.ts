import PdfPrinter from 'pdfmake';
import * as echarts from 'echarts';
import { PDFDocument } from 'pdf-lib';
import { DateTime } from 'luxon';
import { Limits, PanelData, ReportError, Run } from '../common/model';
import { countryName, geohashCenter } from './geo';

const vfs = require('pdfmake/build/vfs_fonts');
const fonts = { Roboto: { normal: Buffer.from(vfs['Roboto-Regular.ttf'], 'base64'), bold: Buffer.from(vfs['Roboto-Medium.ttf'], 'base64'), italics: Buffer.from(vfs['Roboto-Italic.ttf'], 'base64'), bolditalics: Buffer.from(vfs['Roboto-MediumItalic.ttf'], 'base64') } };
export function chartOption(panel: PanelData, color: string): any {
  const metricStart = panel.bucketCount;
  const segment = Math.max(0, panel.schemas.indexOf('segment'));
  const categories = [...new Set(panel.rows.map(row => panel.bucketCount ? row[segment]?.text ?? 'Total' : 'Total'))];
  const groupColumns = Array.from({ length: panel.bucketCount }, (_, i) => i).filter(i => i !== segment);
  const groups = [...new Set(panel.rows.map(row => groupColumns.map(i => row[i].text).join(' / ')))];
  const series: any[] = [];
  for (const group of groups) for (let metric = metricStart; metric < panel.columns.length; metric++) {
    const selected = panel.rows.filter(row => groupColumns.map(i => row[i].text).join(' / ') === group);
    const name = [group, panel.columns[metric]].filter(Boolean).join(' - ');
    const style = panel.params.seriesParams?.[metric - metricStart] ?? {};
    const data = categories.map(category => selected.find(row => (panel.bucketCount ? row[segment]?.text : 'Total') === category)?.[metric]?.value ?? null);
    series.push({ name, type: ['histogram', 'horizontal_bar', 'vertical_bar'].includes(panel.type) ? 'bar' : 'line', animation: false,
      stack: style.mode === 'stacked' ? 'total' : undefined,
      step: style.interpolate === 'step-after' ? 'end' : style.interpolate === 'step-before' ? 'start' : undefined,
      smooth: style.interpolate === 'cardinal',
      label: { show: panel.params.showValues === true, formatter: (item: any) => selected.find(row => (panel.bucketCount ? row[segment]?.text : 'Total') === categories[item.dataIndex])?.[metric]?.text ?? '' },
      areaStyle: panel.type === 'area' ? {} : undefined, showSymbol: categories.length === 1 || panel.params.showCircles === true, symbolSize: 6,
      itemStyle: { color: panel.params?.visColors?.[name] ?? panel.params?.visColors?.[group] ?? panel.params?.visColors?.[panel.columns[metric]] }, data });
  }
  const palette = [color, '#0d9488', '#d97706', '#7c3aed', '#db2777', '#64748b'];
  if (panel.type === 'region_map') {
    const matches = panel.rows.map(row => ({ name: countryName(row[0].text), value: Number(row[metricStart]?.value ?? 0) }));
    const missing = panel.rows.filter((_, i) => !matches[i].name).map(row => row[0].text);
    if (missing.length) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Region map values do not match World Countries: ${missing.slice(0, 5).join(', ')}.`);
    const values = matches.map(item => item.value);
    return { animation: false, visualMap: { show: true, min: Math.min(...values), max: Math.max(...values), left: 0, bottom: 0, inRange: { color: ['#e8f1f9', color] } },
      series: [{ type: 'map', map: 'better-reports-world', roam: false, label: { show: false }, itemStyle: { borderColor: '#a0aec0', borderWidth: 0.3 }, emphasis: { disabled: true }, data: matches }] };
  }
  if (panel.type === 'tile_map') {
    const points = panel.rows.map(row => ({ name: row[0].text, value: [...geohashCenter(String(row[0].value ?? row[0].text)), Number(row[metricStart]?.value ?? 0)] }));
    const max = Math.max(...points.map(point => point.value[2]), 1);
    return { animation: false, geo: { map: 'better-reports-world', roam: false, silent: true, itemStyle: { areaColor: '#f1f5f9', borderColor: '#94a3b8', borderWidth: 0.3 } },
      series: [{ type: 'scatter', coordinateSystem: 'geo', data: points, symbolSize: (value: number[]) => 4 + 17 * Math.sqrt(Math.max(0, value[2]) / max), itemStyle: { color, opacity: 0.7 }, label: { show: false } }] };
  }
  if (panel.type === 'gauge' || panel.type === 'goal') {
    const cell = panel.rows[0]?.[metricStart];
    const value = Number(cell?.value ?? 0);
    const ranges = panel.params.gauge?.colorsRange ?? panel.params.gauge?.ranges ?? [];
    const max = Number(ranges.at(-1)?.to ?? panel.params.gauge?.max ?? Math.max(1, value));
    const min = Number(ranges[0]?.from ?? panel.params.gauge?.min ?? 0);
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Gauge and goal values require a finite, increasing range.');
    if (panel.type === 'gauge') return { animation: false, color: palette, series: [{ type: 'gauge', min, max, startAngle: 210, endAngle: -30,
      progress: { show: true, width: 16 }, axisLine: { lineStyle: { width: 16, ...(ranges.length ? { color: ranges.map((range: any, index: number) => [Math.min(1, Math.max(0, (Number(range.to) - min) / (max - min))), range.color ?? palette[index % palette.length]]) } : {}) } }, axisTick: { show: panel.params.gauge?.showScale === true }, splitLine: { show: panel.params.gauge?.showScale === true }, axisLabel: { show: panel.params.gauge?.showScale === true },
      detail: { valueAnimation: false, formatter: () => cell?.text ?? String(value), fontSize: 24, offsetCenter: [0, '60%'] }, data: [{ value }] }] };
    return { animation: false, color: palette, grid: { left: 20, right: 20, top: 60, bottom: 50 }, xAxis: { type: 'value', min, max, axisLabel: { fontSize: 9 } }, yAxis: { type: 'category', data: [panel.title], axisLabel: { show: false } },
      series: [{ type: 'bar', data: [value], barWidth: 30, label: { show: true, position: 'right', formatter: () => cell?.text ?? String(value) }, showBackground: true, backgroundStyle: { color: '#e2e8f0' } }] };
  }
  if (panel.type === 'heatmap') {
    const x = [...new Set(panel.rows.map(row => row[0].text))];
    const y = [...new Set(panel.rows.map(row => row[1].text))];
    const values = panel.rows.map(row => Number(row[metricStart]?.value ?? 0));
    return { animation: false, grid: { top: 20, left: 70, right: 30, bottom: 65, containLabel: true }, xAxis: { type: 'category', data: x, axisLabel: { fontSize: 8, hideOverlap: true } }, yAxis: { type: 'category', data: y, axisLabel: { fontSize: 8, hideOverlap: true } },
      visualMap: { show: true, min: Math.min(...values), max: Math.max(...values), calculable: false, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#e8f1f9', color] } },
      series: [{ type: 'heatmap', data: panel.rows.map(row => [x.indexOf(row[0].text), y.indexOf(row[1].text), Number(row[metricStart]?.value ?? 0)]), label: { show: panel.params.showValues === true, fontSize: 9 } }] };
  }
  if (panel.type === 'pie') return { animation: false, color: palette, textStyle: { fontFamily: 'Roboto' }, legend: { show: panel.params.addLegend !== false, bottom: 0, type: 'plain', textStyle: { fontSize: 9 } }, series: [{ type: 'pie', radius: panel.params.isDonut ? ['35%', '65%'] : '65%', center: ['50%', '43%'], label: { show: panel.params.labels?.show !== false, fontSize: 10, textBorderWidth: 0, color: '#243247', formatter: (item: any) => `${item.name}: ${panel.rows[item.dataIndex]?.[metricStart]?.text ?? item.value}` }, data: panel.rows.map(row => ({ name: row.slice(0, metricStart).map(c => c.text).join(' / '), value: row[metricStart]?.value, itemStyle: panel.params?.visColors?.[row[0]?.text] ? { color: panel.params.visColors[row[0].text] } : undefined })) }] };
  const horizontal = panel.type === 'horizontal_bar';
  return { animation: false, color: palette, textStyle: { fontFamily: 'Roboto' }, grid: { top: 40, left: horizontal ? 95 : 48, right: 16, bottom: 60, containLabel: true },
    legend: { show: panel.params.addLegend !== false, bottom: 0, textStyle: { fontSize: 9 } },
    xAxis: horizontal ? { type: 'value', ...(panel.axis ? { min: panel.axis.min, max: panel.axis.max, interval: panel.axis.interval } : {}), axisLabel: { fontSize: 9 } } : { type: 'category', data: categories, axisLabel: { fontSize: 9, hideOverlap: true } },
    yAxis: horizontal ? { type: 'category', data: categories, axisLabel: { fontSize: 9, hideOverlap: true } } : { type: 'value', ...(panel.axis ? { min: panel.axis.min, max: panel.axis.max, interval: panel.axis.interval } : {}), axisLabel: { fontSize: 9, ...(panel.axis ? { formatter: (value: number) => panel.axis!.labels[Number(value.toPrecision(12)).toString()] ?? String(value) } : {}) }, name: panel.columns[metricStart], nameGap: 12, nameTextStyle: { fontSize: 9 } }, series };
}
function panelNode(panel: PanelData, width: number, color: string): any {
  if (panel.type === 'table' && Number.isInteger(panel.params.sort?.columnIndex)) {
    const index = panel.params.sort.columnIndex, direction = panel.params.sort.direction === 'desc' ? -1 : 1;
    if (index >= 0 && index < panel.columns.length) panel = { ...panel, rows: [...panel.rows].sort((a, b) => direction * (typeof a[index].value === 'number' && typeof b[index].value === 'number' ? Number(a[index].value) - Number(b[index].value) : a[index].text.localeCompare(b[index].text))) };
  }
  const title = { text: panel.title, fontSize: 12, bold: true, color: '#172b4d', margin: [0, 0, 0, 10] };
  if (!panel.rows.length) return { unbreakable: true, stack: [title, { text: 'No data for this reporting period.', color: '#64748b', margin: [0, 12, 0, 20] }] };
  if (panel.type === 'table') return { stack: [title, { fontSize: 9, table: { headerRows: 1, dontBreakRows: true, widths: panel.columns.map(() => '*'), body: [panel.columns.map(text => ({ text, bold: true, color: 'white', fillColor: color })), ...panel.rows.map(row => row.map(cell => cell.text))] }, layout: { hLineColor: '#dbe3ed', vLineWidth: () => 0, paddingTop: () => 6, paddingBottom: () => 6, fillColor: (row: number) => row > 0 && row % 2 === 0 ? '#f1f5f9' : null } }], margin: [0, 0, 0, 18] };
  if (panel.type === 'metric' && panel.rows.length * (panel.columns.length - panel.bucketCount) > 7) throw new ReportError('LAYOUT_LIMIT', 'This metric panel is too tall for one Letter page. Reduce its buckets or use a table.');
  if (panel.type === 'metric') return { unbreakable: true, stack: [title, ...panel.rows.flatMap(row => row.slice(panel.bucketCount).map((cell, i) => ({ stack: [{ text: [...row.slice(0, panel.bucketCount).map(c => c.text), panel.columns[panel.bucketCount + i]].join(' / '), color: '#64748b', fontSize: 9 }, { text: cell.text, color, fontSize: width < 300 ? 24 : 32, bold: true, margin: [0, 3, 0, 12] }] })))], margin: [0, 0, 0, 18] };
  if (panel.type === 'tagcloud') {
    if (panel.rows.length > 40) throw new ReportError('LAYOUT_LIMIT', 'Tag clouds are limited to 40 terms on a Letter page.');
    const numbers = panel.rows.map(row => Number(row[panel.bucketCount]?.value ?? 0));
    const low = Math.min(...numbers), high = Math.max(...numbers);
    return { unbreakable: true, stack: [title, { text: panel.rows.map((row, index) => ({ text: `${row[0].text}  `, fontSize: 12 + 18 * (numbers[index] - low) / (high - low || 1), color: [color, '#0d9488', '#7c3aed', '#d97706'][index % 4] })), lineHeight: 1.2 }], margin: [0, 0, 0, 18] };
  }
  if (panel.type === 'pie' && panel.columns.length - panel.bucketCount !== 1) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Pie charts require exactly one metric.');
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width, height: 245 });
  try { chart.setOption(chartOption(panel, color)); return { unbreakable: true, stack: [title, { svg: chart.renderToSVGString(), width, height: 245 }], margin: [0, 0, 0, 18] }; }
  finally { chart.dispose(); }
}
export async function renderPdf(run: Run, panels: PanelData[], limits: Limits): Promise<{ pdf: Buffer; pages: number }> {
  const report = run.report, branding = report.branding;
  if (panels.reduce((n, p) => n + (p.type === 'table' ? p.rows.length : 0), 0) > limits.rows) throw new ReportError('QUERY_LIMIT', `The report exceeds ${limits.rows} table rows.`);
  const period = `${DateTime.fromISO(run.from).setZone(report.timezone).toFormat('LLL d, yyyy HH:mm')} - ${DateTime.fromISO(run.to).setZone(report.timezone).toFormat('LLL d, yyyy HH:mm')} (${report.timezone})`;
  const generated = DateTime.fromISO(run.createdAt).setZone(report.timezone).toFormat('LLL d, yyyy HH:mm ZZZZ');
  const content: any[] = [{ text: report.title, fontSize: 23, bold: true, color: branding.color, margin: [0, 0, 0, 12] }];
  for (const section of report.sections) {
    if (section.kind === 'text') content.push({ text: section.text, fontSize: section.style === 'heading' ? 16 : 10, bold: section.bold || section.style === 'heading', alignment: section.alignment, margin: [0, 0, 0, 12] });
    if (section.kind === 'pageBreak') content.push({ text: '', pageBreak: 'before' });
    if (section.kind === 'panels') {
      const width = section.columns === 2 ? 261 : 540;
      const nodes = section.sources.map(key => {
        const panel = panels.find(p => p.key === key);
        if (!panel) throw new ReportError('SOURCE_UNAVAILABLE', 'A selected panel has no query result.');
        return { ...panelNode(panel, width, branding.color), width };
      });
      content.push(section.columns === 2 ? { columns: nodes, columnGap: 18, unbreakable: true } : nodes[0]);
    }
  }
  const definition: any = {
    pageSize: { width: 612, height: 792 }, pageOrientation: 'portrait', pageMargins: [36, 104, 36, 76],
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#243247' }, info: { title: report.title, producer: 'BetterReports 3.8.0.0', creationDate: new Date(run.createdAt) },
    header: { margin: [36, 22, 36, 0], columns: [
      ...(branding.logo ? [{ image: branding.logo, fit: [80, 48], width: 90 }] : []),
      { width: '*', alignment: branding.alignment, stack: [{ text: branding.organization, bold: true, color: branding.color, fontSize: 12 }, { text: branding.header, fontSize: 9, margin: [0, 3, 0, 0] }] }
    ] },
    footer: (page: number, pages: number) => ({ margin: [36, 8, 36, 0], fontSize: 8, color: '#64748b', stack: [
      { text: branding.footer, alignment: branding.alignment },
      ...(branding.showPeriod ? [{ text: period, margin: [0, 3, 0, 0] }] : []),
      { columns: [{ text: branding.showGenerated ? `Generated ${generated}` : '', width: '*' }, { text: branding.showPageNumbers ? `Page ${page} of ${pages}` : '', alignment: 'right', width: 90 }], margin: [0, 3, 0, 0] }
    ] }), content
  };
  const document = new PdfPrinter(fonts as any).createPdfKitDocument(definition);
  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    document.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limits.bytes) { document.destroy(); reject(new ReportError('PDF_SIZE_LIMIT', 'The generated PDF exceeds the configured attachment limit.')); } else chunks.push(chunk); });
    document.on('error', reject); document.on('end', () => resolve(Buffer.concat(chunks))); document.end();
  });
  const parsed = await PDFDocument.load(pdf); const pages = parsed.getPageCount();
  if (pages > limits.pages) throw new ReportError('PAGE_LIMIT', `The report exceeds ${limits.pages} pages. Reduce the content or reporting period.`);
  return { pdf, pages };
}
