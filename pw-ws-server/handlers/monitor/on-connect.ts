// on-connect.ts — Send full monitor snapshot when client connects
export default async (ctx: any) => {
  if (!ctx.source) return;
  const snapshot = ctx.source.readSnapshot(ctx.session);
  ctx.send({
    type: 'snapshot',
    source: ctx.protocol.def.name,
    session: ctx.session,
    data: snapshot,
    timestamp: new Date().toISOString(),
  });
};
