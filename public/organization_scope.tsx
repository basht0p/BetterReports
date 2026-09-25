import React from 'react';
import { EuiCallOut } from '@elastic/eui';

export function OrganizationScope({ value, tenantNames, acknowledged, onChange, onAcknowledge }: {
  value?: string;
  tenantNames: string[];
  acknowledged: boolean;
  onChange: (scope: string | undefined) => void;
  onAcknowledge: (acknowledged: boolean) => void;
}) {
  return <div className="br-organization-scope">
    <label>Organization Scope
      <select value={value === undefined ? 'unselected' : value === '' ? 'global' : `tenant:${value}`}
        onChange={event => {
          const selected = event.target.value;
          onChange(selected === 'unselected' ? undefined : selected === 'global' ? '' : selected.slice('tenant:'.length));
        }}>
        <option value="unselected" disabled>Select an organization scope</option>
        {tenantNames.map(name => <option key={name} value={`tenant:${name}`}>{name}</option>)}
        <option value="global">Global (all organizations)</option>
      </select>
    </label>
    <p className="br-help">{value === undefined ? 'Choose one organization to limit every panel, or Global to include all organizations.' : value === '' ? 'Global includes data from all organizations you can access.' : `Only data for ${value} appears in this report. This limit applies automatically to every panel.`}</p>
    {value === '' && <EuiCallOut title="This report will contain data for multiple customers" color="warning">
      <p>Review the scope before saving this report.</p>
      <label className="br-check"><input type="checkbox" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} />I acknowledge this report will contain data for multiple customers.</label>
    </EuiCallOut>}
  </div>;
}
