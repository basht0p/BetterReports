import { ReportInput } from '../common/model';

// Build isolated, current index patterns for Dashboards' own FilterEditor. Report
// snapshots remain unchanged and continue to drive report execution.
export async function reportFilterIndexPatterns(data: any, sources: ReportInput['sources']) {
  const ids = [...new Set(sources.map(source => source.indexPattern.id))];
  return Promise.all(ids.map(async id => {
    const saved = await data.indexPatterns.get(id);
    const pattern = await data.indexPatterns.create(saved.toSpec(), true);
    const fields = await data.indexPatterns.getFieldsForIndexPattern(pattern);
    const scripted = pattern.getScriptedFields().map((field: any) => field.spec);
    pattern.fields.replaceAll([...fields, ...scripted]);
    return pattern;
  }));
}
