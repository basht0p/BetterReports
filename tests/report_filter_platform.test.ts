import assert from 'node:assert/strict';
import test from 'node:test';
import { getReportFilterUi } from '../public/platform';

test('report filter UI scopes native SearchBar settings without changing core settings', () => {
  const registryKeys: string[] = [];
  const SearchBar = () => null;
  const Provider = () => null;
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    __osdBundles__: {
      get(key: string) {
        registryKeys.push(key);
        if (key === 'plugin/data/public') return { SearchBar };
        if (key === 'plugin/opensearchDashboardsReact/public') return { OpenSearchDashboardsContextProvider: Provider };
        throw new Error('Unexpected bundle ' + key);
      },
    },
  };

  const reads: Array<[string, unknown]> = [];
  const writes: Array<[string, unknown]> = [];
  const uiSettings = {
    marker: 'core settings',
    get(this: any, key: string, fallback?: unknown) {
      assert.equal(this, uiSettings);
      reads.push([key, fallback]);
      return key === 'other:setting' ? 'original value' : true;
    },
    set(this: any, key: string, value: unknown) {
      assert.equal(this, uiSettings);
      writes.push([key, value]);
    },
  };
  const core = { uiSettings, notifications: { toasts: {} }, overlays: {} };
  const data = { query: {} };

  try {
    const bridge = getReportFilterUi(core, data);
    assert.deepEqual(registryKeys, ['plugin/data/public', 'plugin/opensearchDashboardsReact/public']);
    assert.equal(bridge.SearchBar, SearchBar);
    assert.equal(bridge.Provider, Provider);
    assert.equal(bridge.services.data, data);
    assert.equal(bridge.services.notifications, core.notifications);
    assert.equal(bridge.services.appName, 'betterReports');
    assert.equal(core.uiSettings, uiSettings);
    assert.notEqual(bridge.services.uiSettings, uiSettings);

    const scoped = bridge.services.uiSettings;
    assert.equal(scoped.get('home:useNewHomePage'), false);
    assert.equal(scoped.get('query:enhancements:enabled'), false);
    assert.deepEqual(reads, []);
    assert.equal(scoped.get('other:setting', 'fallback'), 'original value');
    assert.deepEqual(reads, [['other:setting', 'fallback']]);
    assert.equal(scoped.marker, 'core settings');
    scoped.set('other:setting', 'new value');
    assert.deepEqual(writes, [['other:setting', 'new value']]);
    assert.equal(uiSettings.get('home:useNewHomePage'), true);
  } finally {
    (globalThis as any).window = originalWindow;
  }
});