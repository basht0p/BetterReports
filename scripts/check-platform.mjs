import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const platform = resolve(process.env.OSD_HOME || '.platform/OpenSearch-Dashboards');
const checks = [
  ['package.json', '"version": "3.8.0"'],
  ['src/plugins/data/server/search/search_service.ts', 'asScoped: async'],
  ['src/plugins/data/server/search/aggs/aggs_service.ts', 'asScopedToClient: async'],
  ['src/plugins/data/common/index_patterns/index_patterns/index_patterns.ts', 'savedObjectToSpec ='],
  ['src/plugins/data/common/search/tabify/tabify.ts', 'export function tabifyAggResponse'],
  ['src/plugins/share/public/types.ts', 'getShareMenuItems:'],
  ['src/core/public/plugins/plugin_reader.ts', '`plugin/${name}/public`'],
  ['packages/osd-optimizer/src/worker/entry_point_creator.ts', '__osdBundles__.define'],
  ['packages/osd-ui-shared-deps/index.js', "'@elastic/eui': '__osdSharedDeps__.ElasticEui'"],
  ['src/legacy/ui/ui_render/ui_render_mixin.js', '${id}.plugin.js']
];
for (const [path, expected] of checks) {
  if (!(await readFile(resolve(platform, path), 'utf8')).includes(expected)) throw new Error(`3.8.0 contract changed: ${path}`);
}
console.log(`Verified ${checks.length} source contracts against OpenSearch Dashboards 3.8.0. This is not a deployment test.`);
