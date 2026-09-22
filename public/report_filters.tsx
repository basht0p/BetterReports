import React, { useEffect, useState } from 'react';
import { EuiCallOut } from '@elastic/eui';
import { ReportInput } from '../common/model';
import { normalizeReportFilters } from './platform';

// Rehydrate saved field definitions without fetching or adopting upstream changes.
export async function snapshotIndexPatterns(data: any, sources: ReportInput['sources']) {
  const patterns = new Map(sources.map(source => [source.indexPattern.id, source.indexPattern]));
  return Promise.all([...patterns.values()].map(pattern => data.indexPatterns.create(
    data.indexPatterns.savedObjectToSpec({ id: pattern.id, attributes: pattern.attributes, references: [] }), true
  )));
}

export function ReportFilters({ data, report, onChange }: {
  data: any; report: ReportInput; onChange: (patch: Partial<ReportInput>) => void;
}) {
  const [patterns, setPatterns] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void snapshotIndexPatterns(data, report.sources).then(result => {
      if (!cancelled) { setPatterns(result); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setError('Unable to load the saved fields for the filter builder. Reopen the report or refresh its sources.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [data, report.sources]);
  const SearchBar = data.ui.SearchBar;
  const changeQuery = ({ query }: any) => {
    if (query && ['kuery', 'lucene'].includes(query.language)) onChange({ query: { language: query.language, query: query.query } });
  };
  return <div className="br-report-filters">
    <h3>Queries and filters</h3>
    {error ? <EuiCallOut color="danger" title={error} /> : loading ? <p role="status">Loading report fields…</p> : <SearchBar
      appName="betterReports" useDefaultBehaviors={false} disableTimeRangeTool
      indexPatterns={patterns} query={report.query} filters={normalizeReportFilters(report.filters)}
      showQueryInput showFilterBar showSaveQuery={false} showDatePicker={false} isFilterBarPortable={false}
      onQueryChange={changeQuery} onQuerySubmit={changeQuery}
      onFiltersUpdated={(filters: ReportInput['filters']) => onChange({ filters: normalizeReportFilters(filters) })}
    />}
    {!report.sources.length && <p className="br-help">Add dashboard content to choose fields for your filters.</p>}
    <p className="br-help">Report filters are combined with the filters saved in each panel. Disabled filters are ignored.</p>
  </div>;
}
