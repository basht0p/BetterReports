# Supported sources and rendering

## Platform

- OpenSearch 3.8.0 and OpenSearch Dashboards 3.8.0 only.
- Security plugin enabled, ordinary Security tenants, including named tenants.
- `opensearch_security.multitenancy.enable_aggregation_view: false` and Workspaces disabled.
- Local OpenSearch data source and ordinary saved index patterns.
- One plugin ZIP for the Dashboards Node.js 22 runtime. No native rasterizer or Chromium installation.

## Sources

Supported aggregation visualization IDs: `area`, `table` (Data Table), `gauge`, `goal`, `heatmap`, `horizontal_bar`, `line`, `metric`, `pie` (including donut), `region_map`, `tagcloud`, `tile_map` (Coordinate Map), and `histogram` (Vertical Bar). A `vertical_bar` ID is accepted as an alias. Charts are rendered as SVG; tables, metrics, and tag clouds use selectable PDF text.

Coordinate Map and Region Map are aggregation-based saved visualizations. The separate Maps application and Timeline expression visualizations are excluded from this release.

Supported enabled aggregation types: `count`, `sum`, `avg`, `min`, `max`, `cardinality`, `percentiles`, `terms`, `date_histogram`, `histogram`, `range`, `filters`, and `geohash_grid` for Coordinate Maps.

Queries are executed through the platform aggregation and search-source services and normalized with its tabification implementation. Source queries, dashboard queries, inherited saved searches, panel queries, filters, and explicit index references are imported. Report time bounds replace source time bounds. Query and filter inheritance otherwise remains additive.

Unsupported configurations are rejected with a reason. These include pipeline aggregations, scripted fields, advanced JSON aggregation overrides, other/missing buckets, partial/all-level table rows, percentage axes, logarithmic/multiple value axes, custom axis extents, mixed chart types, table totals, unsupported field formatters, remote sources, rollups, by-value/unsaved panels, and third-party embeddables. Pie charts require one metric. Tables require full width. Gauge/Goal currently require one unbucketed metric; Heat Map requires two bucket dimensions; Tag Cloud requires one terms bucket; Coordinate Map requires one geohash bucket on a `geo_point` field; Region Map requires one terms bucket and the World Countries layer.

There is no planned support for Controls, Markdown, PPL, TSVB, Vega, or VisBuilder. Maps and Timeline remain excluded. These source types remain explicitly unsupported in the builder.

Report charts preserve data series, ordinary stacking, labels, legends, and configured series colors within a document layout. They are not pixel-identical reproductions of the dashboard's interactive controls or grid. Visible legends use native PDF text beneath the chart, so long legend labels do not overlap graphics. Dashboard-content sections can hide legends. The supported configuration checks are deliberately narrower than the complete Dashboards visualization API; extend the checks and corresponding renderer tests together when adding features.

## Documents

US Letter portrait, 612 × 792 PDF points. Embedded Roboto fonts, native text and tables, SVG chart paths. Raster images are limited to uploaded branding logos. The PDF.js canvas is a browser display of the actual PDF, not the report generation mechanism.

Default ceilings: 20 pages, 10,000 table rows in the report, 10 MiB PDF, five minutes per attempt, two concurrent jobs per instance. Exceeding a ceiling fails the run; no data is silently truncated to satisfy the limit.

Very large metric sections, extremely wide tables, and dense legends should be divided into smaller sections. The release acceptance checklist includes visual review with real customer dashboards before production rollout.

## Schedule semantics

Five-field cron in the chosen IANA timezone; UI presets provide daily, weekly, and monthly starting points. Nonexistent spring-forward times are skipped. Repeated fall-back local minutes run once. A day absent from a month has no occurrence. After downtime, only the latest missed occurrence is enqueued, with older occurrences counted as skipped.

Run IDs deduplicate scheduled occurrences. Reporting bounds and configuration are frozen when the occurrence is enqueued. Notifications acceptance is recorded separately from generation. Unknown delivery outcomes require human review before deliberate resend using **Send now / test**.

The scheduler currently processes at most 1,000 active queue records per scan and the UI lists up to 1,000 recent records. Defaults are designed for 100 schedules; this is not an unbounded enterprise queue.
