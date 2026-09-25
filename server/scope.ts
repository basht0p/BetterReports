import { Identity, Report, ReportError, ReportInput } from '../common/model';

export function tenantOrganization(identity: Identity): string {
  return identity.tenant === '__user__' ? identity.owner : identity.tenant;
}

// Every stored report and run must carry its scope. Older report artifacts were
// rendered before this boundary existed and cannot be proved safe to serve.
export function assertStoredScope(report: Pick<Report, 'tenant' | 'owner' | 'organizationScope'>): string {
  const scope = report.organizationScope;
  if (typeof scope !== 'string') throw new ReportError('ORGANIZATION_SCOPE_REQUIRED', 'Choose an organization scope and save the report again.', 409);
  if (report.tenant !== '' && scope !== tenantOrganization(report)) throw new ReportError('ORGANIZATION_SCOPE_MISMATCH', 'The report organization scope does not match its Security tenant.', 403);
  return scope;
}

export function scopeForInput(input: ReportInput, actor: Identity, tenantNames: string[], canSetOrganizationScope: boolean, acknowledgeGlobalScope = false, saving = false): ReportInput {
  if (actor.tenant !== '') {
    const expected = tenantOrganization(actor);
    if (input.organizationScope !== undefined && input.organizationScope !== expected) throw new ReportError('ORGANIZATION_SCOPE_MISMATCH', 'The organization scope must match the selected Security tenant.', 403);
    return { ...input, organizationScope: expected };
  }
  if (!canSetOrganizationScope) throw new ReportError('FORBIDDEN', 'Organization Scope requires BetterReports administrator permission.', 403);
  if (input.organizationScope === undefined) throw new ReportError('ORGANIZATION_SCOPE_REQUIRED', 'Choose an Organization Scope before continuing.', 400);
  if (input.organizationScope && !tenantNames.includes(input.organizationScope)) throw new ReportError('ORGANIZATION_SCOPE_INVALID', 'Choose an available Security tenant.', 400);
  if (saving && input.organizationScope === '' && !acknowledgeGlobalScope) throw new ReportError('GLOBAL_SCOPE_ACKNOWLEDGMENT_REQUIRED', 'Acknowledge that this report can include data from multiple customers before saving.', 400);
  return input;
}
