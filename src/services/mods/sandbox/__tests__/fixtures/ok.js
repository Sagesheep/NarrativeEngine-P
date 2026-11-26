export default async function (ctx) {
  return {
    kind: 'ok',
    value: ctx.data.value,
    scene: ctx.data.context.scene,
  };
}

