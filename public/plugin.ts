import React from 'react';
import ReactDOM from 'react-dom';
import { App } from './app';
import './style.css';

export class BetterReportsPublicPlugin {
  setup(core: any, deps: any) {
    core.application.register({ id: 'betterReports', title: 'BetterReports', category: { id: 'opensearch', label: 'OpenSearch', order: 1000 }, order: 8000,
      mount: async (params: any) => {
        const [start, plugins] = await core.getStartServices();
        ReactDOM.render(React.createElement(start.i18n.Context, null,
          React.createElement(App, { core: start, data: plugins.data })), params.element);
        return () => ReactDOM.unmountComponentAtNode(params.element);
      } });
    deps.share?.register({ id: 'betterReports', getShareMenuItems: (context: any) => {
      if (!context.objectId || !['dashboard', 'visualization'].includes(context.objectType)) return [];
      return [{ shareMenuItem: { name: 'Create BetterReport', icon: 'document', disabled: context.isDirty,
        toolTipContent: context.isDirty ? 'Save your changes before creating a report.' : undefined,
        onClick: () => { context.onClose(); window.location.assign(core.http.basePath.prepend(`/app/betterReports?sourceType=${context.objectType}&sourceId=${encodeURIComponent(context.objectId)}`)); } }, panel: { id: 'betterReports', title: 'BetterReports', items: [] } }];
    } });
    return {};
  }
  start() { return {}; }
  stop() {}
}
