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
  ['src/core/public/i18n/i18n_service.tsx', 'Context: function I18nContext'],
  ['src/plugins/data/public/ui/ui_service.ts', 'SearchBar,'],
  ['src/plugins/data/public/index.ts', 'mapAndFlattenFilters,'],
  ['src/plugins/data/public/ui/search_bar/create_search_bar.tsx', '{...overrideDefaultBehaviors(props)}'],
  ['src/plugins/data/common/index_patterns/index_patterns/index_patterns.ts', 'skipFetchFields = false'],
  ['src/plugins/data/common/index_patterns/index_patterns/index_patterns.ts', 'getFieldsForIndexPattern = async'],
  ['src/plugins/data/public/ui/filter_bar/filter_editor/lib/filter_editor_utils.ts', 'getFilterableFields(indexPattern: IIndexPattern)'],
  ['src/plugins/data/public/ui/filter_bar/filter_editor/index.tsx', 'createCustomLabel'],
  ['src/core/public/plugins/plugin_reader.ts', '`plugin/${name}/public`'],
  ['packages/osd-optimizer/src/worker/entry_point_creator.ts', '__osdBundles__.define'],
  ['packages/osd-ui-shared-deps/index.js', "'@elastic/eui': '__osdSharedDeps__.ElasticEui'"],
  ['src/legacy/ui/ui_render/ui_render_mixin.js', '${id}.plugin.js']
];
for (const [path, expected] of checks) {
  if (!(await readFile(resolve(platform, path), 'utf8')).includes(expected)) throw new Error(`3.8.0 contract changed: ${path}`);
}
console.log(`Verified ${checks.length} source contracts against OpenSearch Dashboards 3.8.0. This is not a deployment test.`);
