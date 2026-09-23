import React from 'react';
import { Report } from '../common/model';

export type ReportSummary = Pick<Report, 'id' | 'title' | 'revision' | 'updatedAt' | 'owner' | 'tenant' | 'branding'> & {
  canEdit: boolean;
  canRun: boolean;
  canClone: boolean;
  requiresTenantSwitch: boolean;
};

export function tenantLabel(tenant: string) {
  return tenant === '' ? 'Global tenant' : tenant === '__user__' ? 'Private tenant' : tenant;
}

export function ReportCards({ reports, busy, onOpen, onRun, onClone, onDelete }: {
  reports: ReportSummary[];
  busy: boolean;
  onOpen: (report: ReportSummary) => void;
  onRun: (report: ReportSummary) => void;
  onClone: (report: ReportSummary) => void;
  onDelete: (report: ReportSummary) => void;
}) {
  return <div className="br-cards">{reports.map(report => {
    const switchTenant = report.requiresTenantSwitch;
    const branding = report.branding;
    const accent = /^#[0-9a-fA-F]{6}$/.test(branding?.color ?? '') ? branding.color : '#2457a7';
    return <article className="br-report-card" key={report.id} style={{ borderTopColor: `${accent}55` }}>
      <div className="br-card-identity">
        {branding?.logo && <span className="br-card-logo-frame"><img className="br-card-logo" src={branding.logo} alt="" /></span>}
        <div className="br-card-identity-text"><span className="br-eyebrow">PDF REPORT · LETTER</span>
          {branding?.organization && <p className="br-card-organization">{branding.organization}</p>}</div>
      </div>
      <h3>{report.title}</h3>
      <p>Tenant: {report.tenant === '__user__' ? `Private tenant of ${report.owner}` : tenantLabel(report.tenant)} · Created by: {report.owner}</p>
      <p>Revision {report.revision} · Updated {new Date(report.updatedAt).toLocaleDateString()}</p>
      {switchTenant && <p className="br-card-guidance">{report.tenant === '__user__' ? `Only ${report.owner} can open this private report.` : `Switch to ${tenantLabel(report.tenant)} in the Security tenant selector to open or run this report.`}</p>}
      <div className="br-actions">
        <button type="button" disabled={busy || switchTenant} onClick={() => onOpen(report)}>Open</button>
        <button disabled={busy || switchTenant || !report.canRun} onClick={() => onRun(report)}>Generate</button>
        <button disabled={busy || switchTenant || !report.canClone} onClick={() => onClone(report)}>Clone Report</button>
        {report.canEdit && <button disabled={busy || switchTenant} onClick={() => onDelete(report)}>Delete</button>}
      </div>
    </article>;
  })}</div>;
}
