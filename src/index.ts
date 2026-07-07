import type { Core } from '@strapi/strapi';
import { Server } from 'socket.io';

// Actions we grant to the built-in "Authenticated" role on first boot so the
// whole app works without manually clicking around Settings → Roles.
const AUTHENTICATED_ACTIONS = [
  'api::message.message.create',
  'api::message.message.find',
  'api::message.message.findOne',
  'api::message.message.delete', // delete-chat
  'plugin::users-permissions.user.find',
  'plugin::users-permissions.user.findOne',
  'plugin::users-permissions.user.me',
  'plugin::users-permissions.user.update', // edit own profile
];

/**
 * Grant a list of permission actions to a users-permissions role (by type),
 * creating only the permission rows that don't already exist.
 */
async function grantPermissions(
  strapi: Core.Strapi,
  roleType: string,
  actions: string[]
) {
  const role = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: roleType }, populate: ['permissions'] });

  if (!role) {
    strapi.log.warn(`[bootstrap] role "${roleType}" not found; skipping permissions`);
    return;
  }

  const existing = new Set((role.permissions ?? []).map((p: any) => p.action));

  for (const action of actions) {
    if (!existing.has(action)) {
      await strapi.db.query('plugin::users-permissions.permission').create({
        data: { action, role: role.id },
      });
      strapi.log.info(`[bootstrap] granted "${action}" to role "${roleType}"`);
    }
  }
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * Runs before the application starts. We use it to:
   *  1. attach a Socket.IO server to Strapi's underlying HTTP server,
   *  2. authenticate each socket via the users-permissions JWT,
   *  3. join every authenticated socket to a room named by its user id, and
   *  4. seed the Authenticated role permissions so the API is usable out of the box.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // 1–3. Real-time layer -------------------------------------------------
    const io = new Server(strapi.server.httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error('Missing auth token'));

        // Verify the JWT exactly the way the REST API does.
        const { id } = await strapi.plugins['users-permissions'].services.jwt.verify(token);
        (socket as any).userId = id;
        return next();
      } catch (err) {
        strapi.log.warn('[socket] rejected connection: invalid token');
        return next(new Error('Invalid auth token'));
      }
    });

    // Track which users are currently online. A user may have several sockets
    // (multiple tabs/devices); they go "offline" only when the last one drops.
    const online = new Map<number, Set<string>>();

    io.on('connection', (socket) => {
      const userId = (socket as any).userId as number;
      socket.join(`user:${userId}`);
      strapi.log.info(`[socket] user ${userId} connected (${socket.id})`);

      // --- Presence -----------------------------------------------------
      const wasOffline = !online.has(userId);
      if (wasOffline) online.set(userId, new Set());
      online.get(userId)!.add(socket.id);

      // Tell the freshly-connected socket who is already online.
      socket.emit('presence:init', Array.from(online.keys()));
      // Announce this user to everyone else (only on the first socket).
      if (wasOffline) {
        socket.broadcast.emit('presence:update', { userId, online: true });
      }

      // --- WebRTC signaling relay --------------------------------------
      // Pure pass-through to the target user's room. `from` is stamped from
      // the authenticated socket — never trusted from the client payload.
      const relay = (
        inEvent: string,
        outEvent: string,
        extra: (data: any) => Record<string, unknown> = () => ({})
      ) => {
        socket.on(inEvent, (data: any) => {
          const to = data?.toUserId;
          if (!to) return;
          io.to(`user:${to}`).emit(outEvent, { from: userId, ...extra(data) });
        });
      };

      relay('call:invite', 'call:incoming', (d) => ({
        callType: d.callType, // 'audio' | 'video'
        offer: d.offer,
      }));
      relay('call:answer', 'call:answer', (d) => ({ answer: d.answer }));
      relay('call:ice-candidate', 'call:ice-candidate', (d) => ({ candidate: d.candidate }));
      relay('call:reject', 'call:reject');
      relay('call:end', 'call:end');

      socket.on('disconnect', () => {
        strapi.log.info(`[socket] user ${userId} disconnected (${socket.id})`);
        const set = online.get(userId);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) {
            online.delete(userId);
            io.emit('presence:update', { userId, online: false });
          }
        }
      });
    });

    // Expose the io instance so lifecycle hooks can emit events.
    (strapi as any).io = io;

    // 4. Seed permissions --------------------------------------------------
    try {
      await grantPermissions(strapi, 'authenticated', AUTHENTICATED_ACTIONS);
    } catch (err) {
      strapi.log.error('[bootstrap] failed to seed permissions');
      strapi.log.error(err);
    }
  },
};
