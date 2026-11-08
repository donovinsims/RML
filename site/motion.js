import { EASE, backOut, power1In, power3Out } from "./easing.js";
import { renderPipe } from "./pipe-render.js";

const POUR_EVENT = "rml:pour";
const STAGE_COLORS = ["var(--raw)", "var(--mid-1)", "var(--mid-2)", "var(--solution)"];
const RESULTS_FILL = 85;
const RESULT_SURGE_MS = [1100, 900, 900];

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function animate(element, keyframes, options) {
  if (!element || typeof element.animate !== "function") return null;
  return element.animate(keyframes, { fill: "both", ...options });
}

function hide(element, y) {
  element.style.opacity = "0";
  element.style.visibility = "hidden";
  element.style.translate = `0 ${y}px`;
}

function reveal(element, delay, options = {}) {
  element.style.visibility = "visible";
  return animate(element, [
    { opacity: 0, translate: "0 12px" },
    { opacity: 1, translate: "0 0" },
  ], { duration: 600, delay, easing: EASE.POWER2_OUT, ...options });
}

function formatResult(value, format) {
  if (format === "count") return Math.round(value).toLocaleString("en-US");
  if (format === "wholeMultiplier") return `${Math.floor(value)}X`;
  return `${value.toFixed(1)}X`;
}

function parseNumber(text) {
  return Number(text.replace(/[^0-9.]/g, ""));
}

function tubeFormat(text) {
  if (!text.trim().endsWith("X")) return "count";
  return Number.isInteger(parseNumber(text)) ? "wholeMultiplier" : "multiplier";
}

function resultFill(value, format) {
  const interior = format === "count" ? 0 : Math.round(RESULTS_FILL / value);
  return ((RESULTS_FILL - interior) / 100) * 250;
}

function parseResultTube(tube) {
  const number = tube.querySelector("[data-number]");
  if (!number) return null;
  const text = number.textContent.trim();
  return {
    tube,
    number,
    value: parseNumber(text),
    format: tubeFormat(text),
    liquid: tube.querySelector("[data-liquid]"),
    surface: tube.querySelector(".tube-surface"),
    bubbles: [...tube.querySelectorAll("[data-bubble]")],
  };
}

function animateResult(entry, delay = 0) {
  const { liquid, surface, bubbles, number, value, format } = entry;
  if (!liquid || !surface || !number) return;
  const initial = resultFill(value, format);
  const startValue = format === "count" ? 0 : 1;

  setTimeout(() => {
    const surge = RESULT_SURGE_MS[entry.index] || 900;
    if (surface) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--raw").trim();
      const solution = getComputedStyle(document.documentElement).getPropertyValue("--solution").trim();
      surface.style.transition = "none";
      surface.style.fill = solution;
      animate(surface, [{ fill: raw }, { fill: solution }], { duration: 500, easing: EASE.POWER1_IN_OUT });
    }

    setTimeout(() => {
      if (liquid) {
        const started = performance.now();
        const tick = (now) => {
          const t = clamp((now - started) / surge, 0, 1);
          const eased = backOut(t, 1.4);
          liquid.setAttribute("transform", `translate(0 ${initial * (1 - eased)})`);
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }

      if (number) {
        const countStart = performance.now();
        const tick = (now) => {
          const t = clamp((now - countStart) / surge, 0, 1);
          const eased = power3Out(t);
          number.textContent = formatResult(startValue + (value - startValue) * eased, format);
          if (t < 1) requestAnimationFrame(tick);
          else number.textContent = formatResult(value, format);
        };
        requestAnimationFrame(tick);
      }
    }, 450);

    bubbles.forEach((bubble, index) => {
      const start = Number(bubble.getAttribute("cy"));
      const end = 55.5;
      const bubbleDelay = 550 + index * 150;
      setTimeout(() => {
        const bubbleStart = performance.now();
        const duration = 700;
        bubble.setAttribute("opacity", "1");
        const tick = (now) => {
          const t = clamp((now - bubbleStart) / duration, 0, 1);
          const eased = power1In(t);
          bubble.setAttribute("cy", String(start + (end - start) * eased));
          if (t < 1) requestAnimationFrame(tick);
          else {
            bubble.setAttribute("r", "7");
            bubble.setAttribute("opacity", "0");
          }
        };
        requestAnimationFrame(tick);
      }, bubbleDelay);
    });

    if (entry.tube) {
      setTimeout(() => entry.tube.classList.add("is-bubbling"), 450 + surge);
    }
  }, delay);
}

function startResultsMotion() {
  const section = document.getElementById("results");
  const track = section?.querySelector("ul");
  if (!section || !track || reducedMotion()) return;

  const tubes = [...track.querySelectorAll("[data-tube]")];
  const entries = tubes.map((tube, index) => {
    const parsed = parseResultTube(tube);
    if (!parsed) return null;
    parsed.index = index;
    const initial = resultFill(parsed.value, parsed.format);
    parsed.liquid?.setAttribute("transform", `translate(0 ${initial})`);
    if (parsed.surface) parsed.surface.style.fill = "var(--raw)";
    if (parsed.number) parsed.number.textContent = formatResult(parsed.format === "count" ? 0 : 1, parsed.format);
    parsed.bubbles.forEach((bubble) => {
      bubble.setAttribute("opacity", "0");
      bubble.setAttribute("r", bubble.getAttribute("data-base-r") || bubble.getAttribute("r") || "3");
    });
    return parsed;
  }).filter(Boolean);

  const poured = new Set();
  const pour = (index, delay = 0) => {
    const entry = entries[index];
    if (!entry || poured.has(index)) return;
    poured.add(index);
    animateResult(entry, delay);
  };

  const onPour = (event) => {
    if (window.matchMedia("(max-width: 639px)").matches) return;
    const index = Number(event.detail);
    if (Number.isInteger(index)) pour(index);
  };
  window.addEventListener(POUR_EVENT, onPour);

  const isDesktop = () => !window.matchMedia("(max-width: 639px)").matches;
  let triggered = false;
  let mobileActive = false;
  let scrollFrame = 0;
  const checkTriggers = () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const trackBounds = track.getBoundingClientRect();
      // The source creates both result triggers on the track: mobile at 70%
      // and desktop at 15%. The section starts above the track, so using the
      // section here pours before the source does after an instant jump.
      if (!isDesktop() && !mobileActive && trackBounds.top <= window.innerHeight * 0.7) {
        mobileActive = true;
        tubes.forEach((tube) => {
          const tubeBounds = tube.getBoundingClientRect();
          if (tubeBounds.left >= trackBounds.left - tubeBounds.width * 0.4 && tubeBounds.right <= trackBounds.right + tubeBounds.width * 0.4) {
            pour(Number(tube.dataset.tube));
          }
        });
      }
      if (triggered || !isDesktop()) return;
      if (trackBounds.top <= window.innerHeight * 0.15) {
        triggered = true;
        entries.forEach((entry, index) => pour(index, index * 250));
      }
    });
  };
  window.addEventListener("scroll", checkTriggers, { passive: true });
  window.addEventListener("resize", checkTriggers);
  checkTriggers();

  const observer = new IntersectionObserver((observed) => {
    if (!window.matchMedia("(max-width: 639px)").matches || !mobileActive) return;
    for (const item of observed) {
      if (item.isIntersecting) pour(Number(item.target.dataset.tube));
    }
  }, { root: track, threshold: 0.6 });
  tubes.forEach((tube) => observer.observe(tube));

  return () => {
    window.removeEventListener(POUR_EVENT, onPour);
    window.removeEventListener("scroll", checkTriggers);
    window.removeEventListener("resize", checkTriggers);
    observer.disconnect();
    cancelAnimationFrame(scrollFrame);
  };
}

function buildPathModel(main, geometry) {
  const total = main.getTotalLength();
  if (!total) return null;
  const lengths = [0];
  const weights = [0];
  let previous = main.getPointAtLength(0);
  for (let distance = 6; distance < total + 6; distance += 6) {
    const at = Math.min(distance, total);
    const point = main.getPointAtLength(at);
    weights.push(weights[weights.length - 1] + Math.abs(point.y - previous.y) + 0.12 * Math.abs(point.x - previous.x));
    lengths.push(at);
    previous = point;
  }
  const max = weights[weights.length - 1];
  const nearestLength = (point) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let at = 0; at <= total; at += 2) {
      const candidate = main.getPointAtLength(at);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = at;
      }
    }
    return best;
  };
  const valveLengths = geometry.valves.map(nearestLength);
  const tapLengths = geometry.taps.map((tap) => nearestLength({ x: tap.x, y: geometry.manifoldY }));
  const distanceToLength = (distance) => {
    if (distance <= 0) return 0;
    if (distance >= max) return total;
    let low = 0;
    let high = weights.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (weights[middle] < distance) low = middle;
      else high = middle;
    }
    const ratio = (distance - weights[low]) / (weights[high] - weights[low] || 1);
    return lengths[low] + ratio * (lengths[high] - lengths[low]);
  };
  return { total, max, valveLengths, tapLengths, distanceToLength };
}

function primeStageState(stageNodes) {
  stageNodes.forEach((stage, index) => {
    for (const element of stage.querySelectorAll("[data-reveal]")) hide(element, 12);
    if (index === 0) {
      for (const chip of stage.querySelectorAll('[data-anim="chip"]')) hide(chip, -28);
    } else if (index === 1) {
      for (const final of stage.querySelectorAll('[data-anim="status-final"]')) {
        final.style.scale = "0.8";
        hide(final, 0);
      }
      for (const pending of stage.querySelectorAll('[data-anim="status-pending"]')) {
        pending.style.visibility = "visible";
        pending.style.opacity = "1";
      }
    } else if (index === 2) {
      for (const strike of stage.querySelectorAll('[data-anim="strike"]')) strike.style.backgroundSize = "0% 1.5px";
      for (const post of stage.querySelectorAll('[data-anim="post"]')) hide(post, 36);
    } else if (index === 3) {
      for (const row of stage.querySelectorAll('[data-anim="post-row"]')) {
        row.style.translate = "16px 0";
        row.style.opacity = "0";
        row.style.visibility = "hidden";
      }
    }
  });
}

function revealStage(stageNodes, index) {
  const stage = stageNodes[index];
  if (!stage) return;
  stage.querySelectorAll("[data-reveal]").forEach((element, elementIndex) => {
    reveal(element, elementIndex * 100);
  });

  if (index === 0) {
    stage.querySelectorAll('[data-anim="chip"]').forEach((chip, chipIndex) => {
      chip.style.visibility = "visible";
      animate(chip, [
        { opacity: 0, translate: "0 -28px" },
        { opacity: 1, translate: "0 0" },
      ], { duration: 450, delay: 250 + chipIndex * 90, easing: EASE.BACK_OUT_2_2 });
    });
  } else if (index === 1) {
    const finals = stage.querySelectorAll('[data-anim="status-final"]');
    const pendings = stage.querySelectorAll('[data-anim="status-pending"]');
    finals.forEach((final, finalIndex) => {
      const delay = 500 + finalIndex * 450;
      animate(pendings[finalIndex], [{ opacity: 1 }, { opacity: 0 }], { duration: 150, delay, easing: EASE.POWER1_OUT });
      final.style.visibility = "visible";
      animate(final, [
        { opacity: 0, scale: "0.8" },
        { opacity: 1, scale: "1" },
      ], { duration: 350, delay: delay + 100, easing: EASE.BACK_OUT_3 });
    });
  } else if (index === 2) {
    const strikes = stage.querySelectorAll('[data-anim="strike"]');
    strikes.forEach((strike, strikeIndex) => {
      animate(strike, [
        { backgroundSize: "0% 1.5px" },
        { backgroundSize: "100% 1.5px" },
      ], { duration: 400, delay: 400 + strikeIndex * 450, easing: EASE.POWER1_IN_OUT });
    });
    for (const post of stage.querySelectorAll('[data-anim="post"]')) {
      post.style.visibility = "visible";
      animate(post, [
        { opacity: 0, translate: "0 36px" },
        { opacity: 1, translate: "0 0" },
      ], { duration: 600, delay: 1450, easing: EASE.POWER3_OUT });
    }
  } else if (index === 3) {
    stage.querySelectorAll('[data-anim="post-row"]').forEach((row, rowIndex) => {
      row.style.visibility = "visible";
      animate(row, [
        { opacity: 0, translate: "16px 0" },
        { opacity: 1, translate: "0 0" },
      ], { duration: 450, delay: 350 + rowIndex * 250, easing: EASE.POWER2_OUT });
    });
  }
}

function startPipeMotion(svg) {
  const parent = svg.parentElement;
  if (!parent) return () => {};

  const stageNodes = [...parent.querySelectorAll("[data-stage]")];
  const state = {
    primed: false,
    revealed: [false, false, false, false],
    valveOn: [false, false, false, false],
    tapOn: [],
  };
  let geometry = null;
  let pathModel = null;
  let mainPath = null;
  let tapPaths = [];
  let valveCircles = [];
  let renderFrame = 0;
  let fillFrame = 0;
  let destroyed = false;

  const dispatchPour = (index) => {
    window.dispatchEvent(new CustomEvent(POUR_EVENT, { detail: index }));
  };

  const setValve = (index, on) => {
    if (state.valveOn[index] === on) return;
    state.valveOn[index] = on;
    const circle = valveCircles[index];
    if (circle) {
      const from = getComputedStyle(circle).fill;
      const to = on ? STAGE_COLORS[index] : "#FFFFFF";
      circle.style.transition = "none";
      circle.style.fill = to;
      animate(circle, [{ fill: from }, { fill: to }], { duration: 200, easing: EASE.POWER1_OUT });
    }
    if (!on) return;
    const group = svg.querySelector(`[data-valve="${index}"]`);
    if (group && geometry?.valves[index]) {
      group.style.transformBox = "view-box";
      group.style.transformOrigin = `${geometry.valves[index].x}px ${geometry.valves[index].y}px`;
    }
    animate(group, [
      { transform: "scale(1)", easing: EASE.POWER1_OUT },
      { transform: "scale(1.12)", easing: EASE.POWER1_IN },
      { transform: "scale(1)" },
    ], { duration: 280 });
    if (!state.revealed[index]) {
      state.revealed[index] = true;
      revealStage(stageNodes, index);
    }
  };

  const setTap = (index, on) => {
    const tap = tapPaths[index];
    if (!tap) return;
    if (state.tapOn[index] === on) return;
    state.tapOn[index] = on;
    const length = tap.getTotalLength();
    tap.style.strokeDasharray = `${length} ${length}`;
    if (!on) {
      tap.style.strokeDashoffset = String(length);
      return;
    }
    const animation = animate(tap, [
      { strokeDashoffset: length },
      { strokeDashoffset: 0 },
    ], { duration: 350, easing: "linear" });
    if (animation) {
      animation.finished.then(() => {
        if (state.tapOn[index]) dispatchPour(index);
      }).catch(() => {});
    } else {
      tap.style.strokeDashoffset = "0";
      dispatchPour(index);
    }
  };

  const updateFill = () => {
    if (destroyed || !pathModel || !mainPath) return;
    const parentBounds = parent.getBoundingClientRect();
    const total = pathModel.total;
    const start = parentBounds.top + window.scrollY + mainPath.getPointAtLength(0).y - 0.62 * window.innerHeight;
    const end = Math.max(Math.min(start + pathModel.max, document.documentElement.scrollHeight - window.innerHeight), start + 1);
    const progress = clamp((window.scrollY - start) / (end - start), 0, 1);
    const fillLength = pathModel.distanceToLength(progress * pathModel.max);
    mainPath.style.strokeDasharray = `${total} ${total}`;
    mainPath.style.strokeDashoffset = String(total - fillLength);

    pathModel.valveLengths.forEach((length, index) => setValve(index, fillLength >= length));
    pathModel.tapLengths.forEach((length, index) => setTap(index, fillLength >= length));
    if (fillLength >= total - 1) {
      if (geometry?.taps.length) dispatchPour(geometry.taps.length);
    }
  };

  const scheduleFill = () => {
    cancelAnimationFrame(fillFrame);
    fillFrame = requestAnimationFrame(updateFill);
  };

  const bind = () => {
    geometry = renderPipe(svg);
    if (!geometry) return;
    mainPath = svg.querySelector('[data-liquid="main"]');
    tapPaths = [...svg.querySelectorAll('[data-liquid="tap"]')];
    valveCircles = [...svg.querySelectorAll("[data-valve] circle")];
    if (!mainPath) return;

    if (reducedMotion()) {
      mainPath.style.strokeDashoffset = "0";
      tapPaths.forEach((tap) => { tap.style.strokeDashoffset = "0"; });
      valveCircles.forEach((circle, index) => { circle.style.fill = STAGE_COLORS[index]; });
      return;
    }

    if (!state.primed) {
      state.primed = true;
      primeStageState(stageNodes);
    }

    if (state.tapOn.length !== tapPaths.length) state.tapOn = tapPaths.map(() => false);
    valveCircles.forEach((circle, index) => {
      circle.style.fill = state.valveOn[index] ? STAGE_COLORS[index] : "#FFFFFF";
    });
    tapPaths.forEach((tap, index) => {
      const length = tap.getTotalLength();
      tap.style.strokeDasharray = `${length} ${length}`;
      tap.style.strokeDashoffset = state.tapOn[index] ? "0" : String(length);
    });
    pathModel = buildPathModel(mainPath, geometry);
    updateFill();
  };

  const scheduleRender = () => {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(() => {
      if (!destroyed) bind();
    });
  };

  if (!reducedMotion()) bind();
  else renderPipe(svg);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleRender).catch(() => {});
  const observer = new ResizeObserver(scheduleRender);
  observer.observe(parent);
  window.addEventListener("load", scheduleRender, { once: true });
  window.addEventListener("resize", scheduleRender, { passive: true });
  if (!reducedMotion()) window.addEventListener("scroll", scheduleFill, { passive: true });

  return () => {
    destroyed = true;
    observer.disconnect();
    window.removeEventListener("load", scheduleRender);
    window.removeEventListener("resize", scheduleRender);
    window.removeEventListener("scroll", scheduleFill);
    cancelAnimationFrame(renderFrame);
    cancelAnimationFrame(fillFrame);
  };
}

export function setupMotion(pipe) {
  const cleanupResults = startResultsMotion();
  const cleanupPipe = pipe ? startPipeMotion(pipe) : () => {};
  return () => {
    cleanupResults?.();
    cleanupPipe?.();
  };
}
