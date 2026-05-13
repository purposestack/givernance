"use client";

import { useEffect, useRef } from "react";

/**
 * Decorative full-viewport background for auth pages.
 *
 * Renders a slow rain of brand icons (hearts, leaves, shields, QR codes…)
 * drifting down with gentle sway and rotation. The animation runs behind the
 * auth card (z-index -10) and is `aria-hidden` so assistive tech ignores it.
 *
 * Pure Canvas 2D — no Three.js — to keep the auth bundle light and to mirror
 * what the Keycloak theme ships under `infra/keycloak/themes/.../resources/js`.
 *
 * Honours `prefers-reduced-motion: reduce` by rendering a single static frame.
 */

type IconType =
  | "heart"
  | "envelope"
  | "leaf"
  | "hand"
  | "plant"
  | "chart"
  | "check"
  | "rocket"
  | "star"
  | "target"
  | "health"
  | "shield"
  | "ribbon"
  | "qrcode"
  | "calendar";

const ICON_TYPES: readonly IconType[] = [
  "heart",
  "envelope",
  "leaf",
  "hand",
  "plant",
  "chart",
  "check",
  "rocket",
  "star",
  "target",
  "health",
  "shield",
  "ribbon",
  "qrcode",
  "calendar",
];

const COLORS = {
  primary: "#2E7D5E",
  primaryLight: "#4CAF82",
  peach: "#E8A87C",
};

const SPRITE_SIZE = 90;

/**
 * Draw one icon at native resolution into an offscreen canvas. The result is
 * cached once per icon type and reused for every particle of that type.
 */
function paintIcon(ctx: CanvasRenderingContext2D, type: IconType) {
  const size = SPRITE_SIZE;
  const cx = size / 2;
  const cy = size / 2;
  const green = COLORS.primary;
  const greenLight = COLORS.primaryLight;
  const peach = COLORS.peach;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  switch (type) {
    case "heart":
      ctx.fillStyle = peach;
      ctx.strokeStyle = green;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 14);
      ctx.bezierCurveTo(cx - 24, cy - 4, cx - 24, cy - 27, cx, cy - 16);
      ctx.bezierCurveTo(cx + 24, cy - 27, cx + 24, cy - 4, cx, cy + 14);
      ctx.fill();
      ctx.stroke();
      break;
    case "envelope":
      ctx.strokeStyle = green;
      ctx.lineWidth = 3.2;
      ctx.strokeRect(cx - 24, cy - 18, 48, 36);
      ctx.beginPath();
      ctx.moveTo(cx - 24, cy - 18);
      ctx.lineTo(cx, cy + 6);
      ctx.lineTo(cx + 24, cy - 18);
      ctx.stroke();
      break;
    case "leaf":
      ctx.strokeStyle = green;
      ctx.fillStyle = greenLight;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 26);
      ctx.quadraticCurveTo(cx + 20, cy - 5, cx + 16, cy + 20);
      ctx.quadraticCurveTo(cx, cy + 12, cx - 16, cy + 20);
      ctx.quadraticCurveTo(cx - 20, cy - 5, cx, cy - 26);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 22);
      ctx.lineTo(cx, cy + 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 5);
      ctx.lineTo(cx - 12, cy + 9);
      ctx.moveTo(cx + 6, cy - 5);
      ctx.lineTo(cx + 12, cy + 9);
      ctx.stroke();
      break;
    case "hand":
      ctx.strokeStyle = green;
      ctx.fillStyle = greenLight;
      ctx.lineWidth = 3.3;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 2, 14, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx - 13, cy - 6, 5, 9, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const [x, y, w, h] of [
        [cx - 8, cy - 24, 5, 18],
        [cx - 1, cy - 27, 5, 21],
        [cx + 6, cy - 25, 5, 19],
        [cx + 12, cy - 21, 4.5, 15],
      ] as const) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    case "plant":
      ctx.strokeStyle = green;
      ctx.fillStyle = greenLight;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 20);
      ctx.lineTo(cx, cy - 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 2);
      ctx.quadraticCurveTo(cx - 14, cy - 10, cx - 10, cy - 20);
      ctx.quadraticCurveTo(cx - 4, cy - 12, cx, cy - 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 2);
      ctx.quadraticCurveTo(cx + 14, cy - 10, cx + 10, cy - 20);
      ctx.quadraticCurveTo(cx + 4, cy - 12, cx, cy - 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 8);
      ctx.quadraticCurveTo(cx - 8, cy - 20, cx, cy - 28);
      ctx.quadraticCurveTo(cx + 8, cy - 20, cx, cy - 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#8B5E3C";
      ctx.beginPath();
      ctx.ellipse(cx, cy + 22, 10, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "chart":
      ctx.strokeStyle = green;
      ctx.lineWidth = 3;
      ctx.strokeRect(cx - 22, cy - 20, 44, 44);
      ctx.fillStyle = greenLight;
      ctx.fillRect(cx - 17, cy + 8, 8, 18);
      ctx.fillRect(cx - 4, cy - 2, 8, 28);
      ctx.fillRect(cx + 9, cy - 10, 8, 36);
      break;
    case "check":
      ctx.strokeStyle = green;
      ctx.lineWidth = 5.8;
      ctx.beginPath();
      ctx.moveTo(cx - 18, cy + 4);
      ctx.lineTo(cx - 2, cy + 16);
      ctx.lineTo(cx + 20, cy - 16);
      ctx.stroke();
      break;
    case "rocket":
      ctx.fillStyle = greenLight;
      ctx.strokeStyle = green;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 24);
      ctx.lineTo(cx - 12, cy + 10);
      ctx.lineTo(cx + 12, cy + 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = peach;
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy + 10);
      ctx.lineTo(cx, cy + 23);
      ctx.lineTo(cx + 7, cy + 10);
      ctx.closePath();
      ctx.fill();
      break;
    case "star":
      ctx.fillStyle = peach;
      ctx.strokeStyle = green;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 20);
      ctx.lineTo(cx + 6, cy - 6);
      ctx.lineTo(cx + 19, cy - 6);
      ctx.lineTo(cx + 9, cy + 4);
      ctx.lineTo(cx + 12, cy + 17);
      ctx.lineTo(cx, cy + 10);
      ctx.lineTo(cx - 12, cy + 17);
      ctx.lineTo(cx - 9, cy + 4);
      ctx.lineTo(cx - 19, cy - 6);
      ctx.lineTo(cx - 6, cy - 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case "target":
      ctx.strokeStyle = green;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = peach;
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "health":
      ctx.fillStyle = peach;
      ctx.fillRect(cx - 5.5, cy - 19, 11, 38);
      ctx.fillRect(cx - 19, cy - 5.5, 38, 11);
      ctx.strokeStyle = green;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(cx - 5.5, cy - 19, 11, 38);
      ctx.strokeRect(cx - 19, cy - 5.5, 38, 11);
      break;
    case "shield":
      ctx.strokeStyle = green;
      ctx.fillStyle = greenLight;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 22);
      ctx.lineTo(cx + 18, cy - 14);
      ctx.lineTo(cx + 18, cy + 2);
      ctx.quadraticCurveTo(cx + 18, cy + 14, cx, cy + 20);
      ctx.quadraticCurveTo(cx - 18, cy + 14, cx - 18, cy + 2);
      ctx.lineTo(cx - 18, cy - 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy + 2);
      ctx.lineTo(cx - 2, cy + 9);
      ctx.lineTo(cx + 10, cy - 6);
      ctx.stroke();
      break;
    case "ribbon":
      ctx.strokeStyle = green;
      ctx.fillStyle = peach;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy - 18);
      ctx.lineTo(cx, cy - 24);
      ctx.lineTo(cx + 12, cy - 18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = greenLight;
      ctx.beginPath();
      ctx.rect(cx - 10, cy - 18, 20, 22);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = peach;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy + 4);
      ctx.lineTo(cx - 4, cy + 20);
      ctx.lineTo(cx, cy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 10, cy + 4);
      ctx.lineTo(cx + 4, cy + 20);
      ctx.lineTo(cx, cy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = green;
      ctx.stroke();
      break;
    case "qrcode":
      ctx.strokeStyle = green;
      ctx.fillStyle = green;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 18, cy - 18, 36, 36);
      ctx.fillRect(cx - 15, cy - 15, 9, 9);
      ctx.fillRect(cx - 13, cy - 13, 5, 5);
      ctx.fillRect(cx + 6, cy - 15, 9, 9);
      ctx.fillRect(cx + 8, cy - 13, 5, 5);
      ctx.fillRect(cx - 15, cy + 6, 9, 9);
      ctx.fillRect(cx - 13, cy + 8, 5, 5);
      ctx.fillRect(cx - 4, cy - 4, 3, 3);
      ctx.fillRect(cx + 2, cy - 4, 3, 3);
      ctx.fillRect(cx - 4, cy + 2, 3, 3);
      ctx.fillRect(cx + 2, cy + 2, 3, 3);
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
      break;
    case "calendar":
      ctx.strokeStyle = green;
      ctx.fillStyle = greenLight;
      ctx.lineWidth = 2.8;
      ctx.strokeRect(cx - 16, cy - 14, 32, 30);
      ctx.fillRect(cx - 16, cy - 14, 32, 8);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx - 8, cy - 10, 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 8, cy - 10, 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = green;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - 13, cy - 2 + i * 7);
        ctx.lineTo(cx + 13, cy - 2 + i * 7);
        ctx.stroke();
      }
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - 13 + i * 7, cy - 2);
        ctx.lineTo(cx - 13 + i * 7, cy + 14);
        ctx.stroke();
      }
      break;
  }
}

function buildSprites(): Record<IconType, HTMLCanvasElement> {
  const out = {} as Record<IconType, HTMLCanvasElement>;
  for (const type of ICON_TYPES) {
    const c = document.createElement("canvas");
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    const ctx = c.getContext("2d");
    if (ctx) paintIcon(ctx, type);
    out[type] = c;
  }
  return out;
}

type Particle = {
  x: number;
  y: number;
  scale: number;
  speed: number;
  sway: number;
  swayPhase: number;
  rotation: number;
  rotSpeed: number;
  opacity: number;
  type: IconType;
  // Smoothed displacement applied on top of (x, y) by the mouse-repulsion
  // pass. Stored on the particle so the eased return-to-zero doesn't snap
  // when the cursor leaves the influence radius.
  offsetX: number;
  offsetY: number;
};

// Mouse-repulsion tuning. Radius is in CSS pixels — particles closer than
// this from the cursor get pushed away, with a quadratic falloff so the
// effect feels soft near the edge and firm near the centre.
const REPEL_RADIUS = 180;
const REPEL_STRENGTH = 60;

function pickType(): IconType {
  // ICON_TYPES is non-empty and `idx` is bounded by its length, so the
  // narrowing is sound — Math.floor(Math.random() * n) ∈ [0, n).
  const idx = Math.floor(Math.random() * ICON_TYPES.length);
  return ICON_TYPES[idx] as IconType;
}

function makeParticle(width: number, height: number, aboveScreen: boolean): Particle {
  const type = pickType();
  return {
    x: Math.random() * width,
    y: aboveScreen ? -SPRITE_SIZE - Math.random() * height * 0.6 : Math.random() * height,
    scale: 0.55 + Math.random() * 0.55,
    speed: 12 + Math.random() * 28, // px/s
    sway: 6 + Math.random() * 12, // px amplitude
    swayPhase: Math.random() * Math.PI * 2,
    rotation: (Math.random() - 0.5) * Math.PI * 0.4,
    rotSpeed: (Math.random() - 0.5) * 0.25, // rad/s
    opacity: 0.18 + Math.random() * 0.32,
    type,
    offsetX: 0,
    offsetY: 0,
  };
}

export function AuthBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = reduceMotionQuery.matches;

    const sprites = buildSprites();
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    // Cursor in CSS-pixel coordinates relative to the viewport. -1 sentinel
    // means "no active cursor" (initial state or pointer left the window) so
    // the eased offset returns to zero without a hard snap.
    let mouseX = -1;
    let mouseY = -1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Density scales with viewport area so small phones get fewer icons.
      const target = Math.min(110, Math.max(28, Math.round((width * height) / 22000)));
      if (particles.length === 0) {
        particles = Array.from({ length: target }, () => makeParticle(width, height, false));
      } else if (particles.length < target) {
        while (particles.length < target) {
          particles.push(makeParticle(width, height, true));
        }
      } else if (particles.length > target) {
        particles.length = target;
      }
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        const drawSize = SPRITE_SIZE * p.scale;
        // Vertical-position opacity ramp: fully present near the top of
        // the viewport, fading toward the bottom. Clamped to [0, 1] so
        // off-screen positions don't blow up or go negative.
        const yFrac = Math.max(0, Math.min(1, p.y / height));
        const op = p.opacity * (1.25 - yFrac * 1.1);
        ctx.save();
        ctx.globalAlpha = op;
        ctx.translate(p.x + p.offsetX + Math.sin(t / 1200 + p.swayPhase) * p.sway, p.y + p.offsetY);
        ctx.rotate(p.rotation);
        ctx.drawImage(sprites[p.type], -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        ctx.restore();
      }
    };

    let lastTs = performance.now();
    let rafId = 0;

    const tick = (ts: number) => {
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      // Framerate-independent easing factor for the cursor-offset low-pass.
      // 1 − exp(−dt · k) converges to the target with time constant 1/k
      // regardless of frame timing; k = 6 → ~95 % settled in 0.5 s.
      const easing = 1 - Math.exp(-dt * 6);
      const cursorActive = mouseX >= 0 && mouseY >= 0;
      for (const p of particles) {
        p.y += p.speed * dt;
        p.rotation += p.rotSpeed * dt;
        if (p.y - SPRITE_SIZE > height) {
          const fresh = makeParticle(width, height, true);
          Object.assign(p, fresh);
        }
        // Compute the cursor-repulsion target. Quadratic falloff inside the
        // radius, zero outside. The eased offset converges toward this every
        // frame, so leaving the cursor stationary lets icons settle and
        // leaving the window resets the target to zero (smooth return).
        let targetOx = 0;
        let targetOy = 0;
        if (cursorActive) {
          const dx = p.x - mouseX;
          const dy = p.y - mouseY;
          const dist = Math.hypot(dx, dy);
          if (dist > 0 && dist < REPEL_RADIUS) {
            const f = 1 - dist / REPEL_RADIUS;
            const falloff = f * f;
            targetOx = (dx / dist) * falloff * REPEL_STRENGTH;
            targetOy = (dy / dist) * falloff * REPEL_STRENGTH;
          }
        }
        p.offsetX += (targetOx - p.offsetX) * easing;
        p.offsetY += (targetOy - p.offsetY) * easing;
      }
      draw(ts);
      rafId = requestAnimationFrame(tick);
    };

    resize();

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = requestAnimationFrame(tick);
    }

    const onMotionChange = (e: MediaQueryListEvent) => {
      const next = e.matches;
      if (next === reduceMotion) return;
      reduceMotion = next;
      if (reduceMotion) {
        cancelAnimationFrame(rafId);
        draw(0);
      } else {
        lastTs = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    };

    // Cursor tracking — only meaningful when motion is allowed; under
    // reduce-motion the canvas paints a single static frame and there is
    // no rAF loop to consume the position.
    const onPointerMove = (e: PointerEvent) => {
      if (reduceMotion) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
    };
    const onPointerLeave = () => {
      mouseX = -1;
      mouseY = -1;
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    reduceMotionQuery.addEventListener("change", onMotionChange);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      reduceMotionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
