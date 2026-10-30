// raincloud.js: tiny canvas player for raincloud.png and raincloud.json (renderer process).
// Usage:
//   import meta from './raincloud.json' with { type: 'json' };   // or require() in CommonJS
//   const img = new Image(); img.src = './raincloud.png'; await img.decode();
//   const pet = createRaincloud(meta, img);
//   // weatherPose comes from weather.js in the main process (send it over IPC), or null:
//   pet.draw(ctx, 'celebrate', 0, 0, 4, performance.now(), weatherPose);
// Rule: a reaction in meta.ambientReactions shows the weather pose when there is one.
// Every other reaction keeps its own pose. Unknown reactions fall back to the default pose.
export function createRaincloud(meta, img) {
  return {
    poseFor(reaction, weatherPose) {
      if (weatherPose && meta.poses[weatherPose] && meta.ambientReactions.includes(reaction)) return weatherPose;
      return meta.reactions[reaction] || meta.defaultPose;
    },
    draw(ctx, reaction, x, y, scale, timeMs, weatherPose) {
      const pose = meta.poses[this.poseFor(reaction, weatherPose)];
      const frame = Math.floor((timeMs / 1000) * pose.fps) % meta.frameCount;
      const s = meta.frameSize;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, frame * s, pose.row * s, s, s, x, y, s * scale, s * scale);
    }
  };
}
