import { ReportError } from '../common/model';

// Timeline expressions are a language, not aggregation visState. Accept only a
// small declarative subset; never evaluate arbitrary functions from a saved object.
function argumentsOf(input: string): Record<string, string> {
  const args: Record<string, string> = {};
  const parts = input.match(/(?:'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|[^,])+/g) ?? [];
  for (const part of parts) {
    const match = /^\s*([a-zA-Z]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline requires named expression arguments.');
    let value = match[2];
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    if (Object.hasOwn(args, match[1])) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Duplicate Timeline argument ${match[1]}.`);
    args[match[1]] = value;
  }
  return args;
}

export function parseTimeline(expression: string) {
  const match = /^\s*\.(?:es|opensearch)\(([^)]*)\)\s*$/.exec(expression);
  if (!match) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline supports one .es() or .opensearch() series with no chained functions.');
  const args = argumentsOf(match[1]);
  for (const key of Object.keys(args)) if (!['index', 'timefield', 'q', 'metric', 'split'].includes(key)) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Timeline argument ${key} is not supported.`);
  if (!args.index) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline needs an explicit index pattern in its expression.');
  if (!/^[a-zA-Z0-9_.*-]+$/.test(args.index)) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline index pattern contains unsupported characters.');
  const metric = args.metric ? /^(count|sum|avg|min|max|cardinality):?([a-zA-Z0-9_.-]+)?$/.exec(args.metric) : null;
  if (args.metric && !metric) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline metric must be count, sum, avg, min, max, or cardinality.');
  if (metric?.[1] !== 'count' && !metric?.[2]) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline metric requires a field.');
  const split = args.split ? /^([a-zA-Z0-9_.-]+):(\d+)$/.exec(args.split) : null;
  if (args.split && (!split || Number(split[2]) < 1 || Number(split[2]) > 100)) throw new ReportError('UNSUPPORTED_CONFIGURATION', 'Timeline split must name a field and a size from 1 to 100.');
  return { index: args.index, timefield: args.timefield, query: args.q ?? '', metric: { type: metric?.[1] ?? 'count', field: metric?.[2] }, split: split ? { field: split[1], size: Number(split[2]) } : undefined };
}
