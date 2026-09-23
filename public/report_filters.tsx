import React, { useEffect, useMemo, useState } from 'react';
import { EuiCallOut } from '@elastic/eui';
import { ReportInput } from '../common/model';
import { getReportFilterUi, normalizeReportFilters } from './platform';
import { reportFilterIndexPatterns } from './report_filter_patterns';

export function ReportFilters({ core, data, report, onChange }: {
  core: any; data: any; report: ReportInput; onChange: (patch: Partial<ReportInput>) => void;
}) {
  const [patterns, setPatterns] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void reportFilterIndexPatterns(data, report.sources).then(result => {
      if (!cancelled) { setPatterns(result); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setError('Unable to load current index pattern fields for the filter builder. Check your data access or refresh the index pattern.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [data, report.sources]);
  const { SearchBar, Provider, services } = useMemo(() => getReportFilterUi(core, data), [core, data]);
  const savedQuery = report.query.query.trim();
  return <div className="br-report-filters">
    <h3>Filters</h3>
    {savedQuery && <div className="br-legacy-query"
      title={`Saved ${report.query.language === 'lucene' ? 'Lucene' : 'DQL'} filter: ${savedQuery}`}>
      <span className="br-legacy-query-text">Saved filter: {savedQuery}</span>
      <button type="button" aria-label="Remove saved filter"
        onClick={() => onChange({ query: { ...report.query, query: '' } })}>Remove</button>
    </div>}
    {error ? <EuiCallOut color="danger" title={error} /> : loading ? <p role="status">Loading report fields…</p> : <Provider services={services}><SearchBar
      appName="betterReports" useDefaultBehaviors={false} disableTimeRangeTool
      indexPatterns={patterns} query={report.query} filters={normalizeReportFilters(report.filters)}
      showQueryBar={false} showQueryInput={false} showFilterBar showSaveQuery={false} showDatePicker={false} isFilterBarPortable={false}
      onClearSavedQuery={() => {}}
      timeHistory={data.query.timefilter.history}
      onFiltersUpdated={(filters: ReportInput['filters']) => onChange({ filters: normalizeReportFilters(filters) })}
    /></Provider>}
    {!report.sources.length && <p className="br-help">Add dashboard content to choose fields for your filters.</p>}
    <p className="br-help">Report filters are combined with the filters saved in each panel. Disabled filters are ignored.</p>
  </div>;
}
