// Runtime integration is isolated in server/platform.ts. The exact platform contracts
// are checked separately against the pinned OpenSearch Dashboards source tree.
declare module '@osd/config-schema' { export const schema: any; }
declare module '@elastic/eui' {
  import * as React from 'react';
  export const EuiButton: React.ComponentType<any>;
  export const EuiButtonEmpty: React.ComponentType<any>;
  export const EuiCallOut: React.ComponentType<any>;
  export const EuiPanel: React.ComponentType<any>;
  export const EuiTitle: React.ComponentType<any>;
}
