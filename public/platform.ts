// Use the exact platform's public filter normalizer, without touching the global
// filter manager (which would leak report filters into Discover or dashboards).
export function normalizeReportFilters(filters: Record<string, any>[]) {
  const data = (window as any).__osdBundles__.get('plugin/data/public');
  return data.opensearchFilters.mapAndFlattenFilters(JSON.parse(JSON.stringify(filters)));
}
