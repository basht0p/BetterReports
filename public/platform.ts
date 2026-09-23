// Use the exact platform's public filter normalizer, without touching the global
// filter manager (which would leak report filters into Discover or dashboards).
export function normalizeReportFilters(filters: Record<string, any>[]) {
  const data = (window as any).__osdBundles__.get('plugin/data/public');
  return data.opensearchFilters.mapAndFlattenFilters(JSON.parse(JSON.stringify(filters)));
}

// The report editor uses the platform's filter bar without its query editor. In
// the optional new header, SearchBar hides an empty filter bar, including its
// Add filter action. Scope the standard filter layout to this editor only.
export function getReportFilterUi(core: any, data: any) {
  const bundles = (window as any).__osdBundles__;
  const SearchBar = bundles.get('plugin/data/public').SearchBar;
  const Provider = bundles.get('plugin/opensearchDashboardsReact/public').OpenSearchDashboardsContextProvider;
  const uiSettings = new Proxy(core.uiSettings, {
    get(target, property) {
      if (property === 'get') return (key: string, ...args: any[]) =>
        key === 'home:useNewHomePage' || key === 'query:enhancements:enabled'
          ? false : target.get(key, ...args);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { SearchBar, Provider, services: { ...core, data, appName: 'betterReports', uiSettings } };
}
