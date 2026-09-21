import { mkdir, writeFile } from 'fs/promises';
import { demoFixture } from '../tests/fixtures';
import { renderPdf } from '../server/render';
async function main() {
  const fixture = demoFixture();
  const result = await renderPdf(fixture.run, fixture.panels, fixture.limits);
  await mkdir('output/pdf', { recursive: true });
  await writeFile('output/pdf/BetterReports-demo.pdf', result.pdf);
  console.log(`Created output/pdf/BetterReports-demo.pdf (${result.pages} Letter pages, synthetic data).`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
