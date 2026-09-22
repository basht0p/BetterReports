import React from 'react';
import { EuiComboBox, EuiFormRow } from '@elastic/eui';

export function TimezonePicker({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const zones: string[] = (Intl as any).supportedValuesOf('timeZone');
  const options = [...new Set(['UTC', value, ...zones])].sort().map(label => ({ label }));
  return <EuiFormRow label="Timezone" fullWidth><EuiComboBox aria-label="Timezone" fullWidth
    singleSelection={{ asPlainText: true }} isClearable={false} options={options}
    selectedOptions={[{ label: value }]} onChange={(selected: { label: string }[]) => { if (selected[0]) onChange(selected[0].label); }} />
  </EuiFormRow>;
}
