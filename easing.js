const round = (value) => Number(value.toFixed(5));

function linearEasing(progress, samples = 32) {
  const points = [];
  for (let index = 0; index <= samples; index += 1) {
    const time = index / samples;
    points.push(`${round(progress(time))} ${round(time * 100)}%`);
  }
  return `linear(${points.join(", ")})`;
}

// GSAP's power names are one exponent lower than their mathematical names:
// power1 = quadratic, power2 = cubic, power3 = quartic.
export const power1In = (time) => time ** 2;
export const power1Out = (time) => 1 - (1 - time) ** 2;
export const power1InOut = (time) => time < 0.5
  ? 2 * time ** 2
  : 1 - (-2 * time + 2) ** 2 / 2;
export const power2Out = (time) => 1 - (1 - time) ** 3;
export const power3Out = (time) => 1 - (1 - time) ** 4;
export const backOut = (time, overshoot = 1.70158) =>
  1 + (overshoot + 1) * (time - 1) ** 3 + overshoot * (time - 1) ** 2;

export const EASE = Object.freeze({
  POWER1_IN: linearEasing(power1In),
  POWER1_OUT: linearEasing(power1Out),
  POWER1_IN_OUT: linearEasing(power1InOut),
  POWER2_OUT: linearEasing(power2Out),
  POWER3_OUT: linearEasing(power3Out),
  BACK_OUT_1_4: linearEasing((time) => backOut(time, 1.4)),
  BACK_OUT_2_2: linearEasing((time) => backOut(time, 2.2)),
  BACK_OUT_3: linearEasing((time) => backOut(time, 3)),
});
