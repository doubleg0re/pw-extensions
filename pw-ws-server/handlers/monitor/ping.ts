// ping.ts — Simple ping/pong handler
export default async (msg: any, ctx: any) => {
  ctx.send({ type: 'pong', message: msg.message || 'pong', timestamp: new Date().toISOString() });
};
