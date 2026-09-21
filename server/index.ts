export { config } from './config';
import { BetterReportsPlugin } from './plugin';
export const plugin = (context: any) => new BetterReportsPlugin(context);
