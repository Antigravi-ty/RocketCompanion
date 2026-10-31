/**
 * CubicBezier.js
 * High performance cubic bezier solver matching CSS cubic-bezier(x1, y1, x2, y2).
 */

export function createCubicBezier(x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1.0) {
  // Clamp control x points to [0, 1] as per CSS spec
  const cx1 = Math.min(1, Math.max(0, x1));
  const cx2 = Math.min(1, Math.max(0, x2));

  return function evaluate(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    // Newton-Raphson iteration to solve for parametric u such that x(u) = t
    let u = t;
    for (let i = 0; i < 8; i++) {
      const oneMinusU = 1.0 - u;
      const currentX =
        3 * oneMinusU * oneMinusU * u * cx1 +
        3 * oneMinusU * u * u * cx2 +
        u * u * u;

      const diff = currentX - t;
      if (Math.abs(diff) < 0.0005) break;

      // Derivative dx/du
      const dX =
        3 * oneMinusU * oneMinusU * cx1 +
        6 * oneMinusU * u * (cx2 - cx1) +
        3 * u * u * (1.0 - cx2);

      if (Math.abs(dX) < 0.0001) break;
      u = Math.min(1, Math.max(0, u - diff / dX));
    }

    // Evaluate y(u)
    const oneMinusU = 1.0 - u;
    return (
      3 * oneMinusU * oneMinusU * u * y1 +
      3 * oneMinusU * u * u * y2 +
      u * u * u
    );
  };
}
