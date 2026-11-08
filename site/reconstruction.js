import { renderPipe } from "./pipe-render.js";
import { setupMotion } from "./motion.js";

function setupMobileMenu() {
  const toggle = document.querySelector('button[aria-controls="mobile-nav"]');
  const panel = document.getElementById("mobile-nav");
  if (!toggle || !panel) return;

  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    const label = toggle.querySelector(".sr-only");
    if (label) label.textContent = open ? "Close menu" : "Open menu";
  };

  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  panel.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
}

function setupStaticMarquee() {
  const marquee = document.querySelector(".marquee");
  const track = marquee?.querySelector(".marquee-track");
  if (!marquee || !track) return;
  // The source marquee is intentionally paused in this static reconstruction.
  // Keep its fade mask, expose horizontal access, and start at the clean edge.
  marquee.style.overflowX = "auto";
  track.style.animation = "none";
  track.style.transform = "none";
  marquee.scrollLeft = 0;
}

function setupFaq() {
  const buttons = document.querySelectorAll('#faq button[aria-controls][aria-expanded]');
  for (const button of buttons) {
    const region = document.getElementById(button.getAttribute("aria-controls"));
    if (!region) continue;
    region.hidden = button.getAttribute("aria-expanded") !== "true";
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!open));
      region.hidden = open;
      const icon = button.querySelector("svg");
      if (icon) icon.style.transform = open ? "" : "rotate(45deg)";
    });
  }
}

function setupResultDots() {
  const dots = [...document.querySelectorAll('button[aria-label^="Show result "]')];
  if (!dots.length) return;
  const track = [...document.querySelectorAll("ul")].find((list) => list.querySelector("[data-tube]"));
  if (!track) return;
  const cards = [...track.querySelectorAll("[data-tube]")];
  if (cards.length !== dots.length) return;

  const select = (index, scroll) => {
    if (scroll) {
      const card = cards[index];
      track.scrollTo({
        left: card.offsetLeft - (track.clientWidth - card.clientWidth) / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
    dots.forEach((dot, dotIndex) => {
      const active = dotIndex === index;
      if (active) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
      const mark = dot.querySelector("span");
      if (!mark) return;
      mark.classList.toggle("w-2.5", !active);
      mark.classList.toggle("w-6", active);
      mark.classList.toggle("bg-bench-dark-rail", !active);
      mark.classList.toggle("bg-bench-dark-ink", active);
      mark.classList.toggle("ring-2", !active);
    });
  };

  dots.forEach((dot, index) => {
    dot.addEventListener("click", () => select(index, true));
  });

  let frame = 0;
  track.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const middle = track.scrollLeft + track.clientWidth / 2;
      let nearest = 0;
      let best = Infinity;
      cards.forEach((card, index) => {
        const distance = Math.abs(card.offsetLeft + card.clientWidth / 2 - middle);
        if (distance < best) {
          best = distance;
          nearest = index;
        }
      });
      select(nearest, false);
    });
  }, { passive: true });
}

function setupFormGuard() {
  const form = [...document.querySelectorAll("form")].find((candidate) => candidate.querySelector('input[name="fullName"]'));
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let status = form.parentElement?.querySelector("[data-reconstruction-status]");
    if (!status) {
      status = document.createElement("p");
      status.dataset.reconstructionStatus = "";
      status.setAttribute("role", "status");
      status.className = "mt-4 rounded-[16px] border-2 border-ink bg-glass px-4 py-3 text-[15px] font-semibold text-ink";
      form.after(status);
    }
    status.textContent = "This is a static preview, so the application was not sent.";
  });
}

function setupPipe() {
  const pipe = document.getElementById("rml-pipe");
  try {
    setupMotion(pipe);
  } catch (error) {
    if (pipe) {
      pipe.dataset.pipeError = error instanceof Error ? error.message : String(error);
      try {
        renderPipe(pipe);
      } catch {
        // The geometry module is covered by its own tests; keep the page usable here.
      }
    }
  }
}

function init() {
  setupMobileMenu();
  setupStaticMarquee();
  setupFaq();
  setupResultDots();
  setupFormGuard();
  setupPipe();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
