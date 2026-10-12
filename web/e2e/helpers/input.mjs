// Pointer input. Mouse goes through page.mouse. Touch goes through the DevTools protocol, because
// page.touchscreen only taps: a drag needs touchStart, touchMove and touchEnd.

export async function mouseDrag(page, points, { button = "left" } = {}) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down({ button });
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.up({ button });
}

export async function mouseClick(page, p, opts = {}) {
  await page.mouse.click(p.x, p.y, opts);
}

export async function touchDrag(page, points) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (p) => [{ x: p.x, y: p.y, id: 1 }];
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(points[0]) });
    for (const p of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(p) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

export async function touchTap(page, p) {
  await page.touchscreen.tap(p.x, p.y);
}

/** Points on a straight line from a to b, `n` steps. */
export function line(a, b, n = 8) {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

/** The input device of a project: touch on the phone projects, mouse on the desktop one. */
export function pointer(page, testInfo) {
  const touch = !!testInfo.project.use.hasTouch;
  return {
    touch,
    tap: (p) => (touch ? touchTap(page, p) : mouseClick(page, p)),
    drag: (points) => (touch ? touchDrag(page, points) : mouseDrag(page, points)),
  };
}
