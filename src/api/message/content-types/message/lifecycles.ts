/**
 * `message` lifecycle hooks.
 *
 * After a message is created we re-fetch it with its relations populated and
 * emit a `message:create` event over Socket.IO to both the sender's and the
 * recipient's rooms (see `src/index.ts` for how sockets join `user:<id>`).
 * The payload is the flattened Strapi 5 entity, so the client can read
 * `message.sender.id` / `message.content` directly — no `.attributes` nesting.
 */
export default {
  async afterCreate(event: any) {
    const io = (strapi as any).io;
    if (!io) return;

    const { result } = event;

    const message = await strapi.documents('api::message.message').findOne({
      documentId: result.documentId,
      populate: ['sender', 'recipient'],
    });

    if (!message) return;

    const senderId = (message as any).sender?.id;
    const recipientId = (message as any).recipient?.id;

    if (senderId) io.to(`user:${senderId}`).emit('message:create', message);
    if (recipientId && recipientId !== senderId) {
      io.to(`user:${recipientId}`).emit('message:create', message);
    }
  },
};
