/** Serve authenticated generic icons at explicitly configured application icon URLs. */
import { readFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';

/** Stable Cordis function-plugin identity. */
export const name = 'local-open-in-app-icons';
/** Reuse the HTTP route registry and the existing browser authentication policy. */
export const inject = ['webServer', 'connection'];
/** Selected application ids and successful-image cache lifetime; neither has an implicit default. */
export const Config = z.object({
  applicationIds: z.array(z.string().pattern(/^[a-z][a-z0-9-]*$/).required()).min(1).required(),
  cacheMaxAgeSeconds: z.natural().required(),
});

/**
 * Register exact icon routes, leaving the upstream prefix and application launcher intact.
 * @param {object} ctx - Cordis context providing webServer, connection, and effects.
 * @param {{applicationIds: string[], cacheMaxAgeSeconds: number}} config - Validated local icon selection.
 * @returns {Promise<void>} Resolves after all routes are registered; a missing asset or duplicate id rejects activation.
 */
export async function apply(ctx, config) {
  if (new Set(config.applicationIds).size !== config.applicationIds.length) {
    throw new Error('local-open-in-app-icons: applicationIds must not contain duplicate ids');
  }
  const icon = await readFile(new URL('./assets/fallback.svg', import.meta.url));
  for (const id of config.applicationIds) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/open-in-app/icon/${id}`,
      handler(req, res) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': `private, max-age=${config.cacheMaxAgeSeconds}`,
        });
        res.end(icon);
      },
    }), `local-open-in-app-icons: ${id}`);
  }
}
