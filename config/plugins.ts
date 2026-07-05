import type { Core } from '@strapi/strapi';

// Real-time is implemented manually with Socket.IO in `src/index.ts`
// (see the bootstrap step). We intentionally do NOT use `strapi-plugin-io`,
// which has not been verified against Strapi 5.
const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({});

export default config;
