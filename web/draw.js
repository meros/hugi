// Canvas drawing shared by the Maker and the game. Colours come from the page's CSS variables.

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A tile: an almost full square with softly rounded corners, so that neighbouring tiles read as one picture.
// margin overrides the gap to the cell edge (the game's reveal sets 0 so that the tiles join).
export function tile(ctx, px, py, cell, color, margin = null) {
  const m = margin ?? (cell < 9 ? 0 : Math.max(0.5, cell * 0.035));
  const size = cell - 2 * m;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect && cell >= 9) ctx.roundRect(px + m, py + m, size, size, cell * 0.12);
  else ctx.rect(px + m, py + m, size, size);
  ctx.fill();
}

// A mark: a quiet dot at the cell centre. There are no crosses.
export function dot(ctx, px, py, cell, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px + cell / 2, py + cell / 2, Math.max(1.5, cell * 0.09), 0, Math.PI * 2);
  ctx.fill();
}
