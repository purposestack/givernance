/*
 * Givernance — Keycloak login theme — decorative auth background.
 *
 * Self-hosted Canvas 2D animation: a slow rain of brand icons drifting down
 * with gentle sway + rotation. Mirrors packages/web/src/components/auth/
 * auth-background.tsx so the SPA login and the Keycloak login share the
 * same visual identity.
 *
 * No external assets / no CDN — required for GDPR compliance (LG München
 * ruling): the theme must not issue any third-party request from the auth
 * page. Honours prefers-reduced-motion by rendering a single static frame.
 *
 * Expects <canvas id="gv-auth-bg"> in template.ftl. Defers initialisation
 * until DOMContentLoaded so it runs even when the script tag is in <head>.
 */
(function () {
  "use strict";

  var COLORS = {
    primary: "#2E7D5E",
    primaryLight: "#4CAF82",
    peach: "#E8A87C",
  };

  var ICON_TYPES = [
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

  var SPRITE_SIZE = 90;

  // Mouse-repulsion tuning. Radius is in CSS pixels — particles closer than
  // this from the cursor get pushed away, with a quadratic falloff so the
  // effect feels soft near the edge and firm near the centre.
  var REPEL_RADIUS = 180;
  var REPEL_STRENGTH = 60;

  // Wheel-driven speed multiplier bounds. Exponential mapping
  // (`Math.exp(deltaY * SPEED_SENSITIVITY)`) means each wheel tick scales
  // the multiplier by a constant factor, so a few ticks span the whole
  // glacial-to-frantic range without feeling sluggish near the middle.
  var SPEED_MIN = 0.1;
  var SPEED_MAX = 20;
  var SPEED_SENSITIVITY = 0.003;

  function paintIcon(ctx, type) {
    var size = SPRITE_SIZE;
    var cx = size / 2;
    var cy = size / 2;
    var green = COLORS.primary;
    var greenLight = COLORS.primaryLight;
    var peach = COLORS.peach;

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
        var fingers = [
          [cx - 8, cy - 24, 5, 18],
          [cx - 1, cy - 27, 5, 21],
          [cx + 6, cy - 25, 5, 19],
          [cx + 12, cy - 21, 4.5, 15],
        ];
        for (var i = 0; i < fingers.length; i++) {
          var f = fingers[i];
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(f[0], f[1], f[2], f[3], 2);
          } else {
            ctx.rect(f[0], f[1], f[2], f[3]);
          }
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
        for (var r = 0; r < 4; r++) {
          ctx.beginPath();
          ctx.moveTo(cx - 13, cy - 2 + r * 7);
          ctx.lineTo(cx + 13, cy - 2 + r * 7);
          ctx.stroke();
        }
        for (var c = 0; c < 5; c++) {
          ctx.beginPath();
          ctx.moveTo(cx - 13 + c * 7, cy - 2);
          ctx.lineTo(cx - 13 + c * 7, cy + 14);
          ctx.stroke();
        }
        break;
    }
  }

  function buildSprites() {
    var out = {};
    for (var i = 0; i < ICON_TYPES.length; i++) {
      var type = ICON_TYPES[i];
      var c = document.createElement("canvas");
      c.width = SPRITE_SIZE;
      c.height = SPRITE_SIZE;
      var ctx = c.getContext("2d");
      if (ctx) paintIcon(ctx, type);
      out[type] = c;
    }
    return out;
  }

  function makeParticle(width, height, aboveScreen) {
    var type = ICON_TYPES[Math.floor(Math.random() * ICON_TYPES.length)];
    return {
      x: Math.random() * width,
      y: aboveScreen
        ? -SPRITE_SIZE - Math.random() * height * 0.6
        : Math.random() * height,
      scale: 0.55 + Math.random() * 0.55,
      speed: 12 + Math.random() * 28,
      sway: 6 + Math.random() * 12,
      swayPhase: Math.random() * Math.PI * 2,
      rotation: (Math.random() - 0.5) * Math.PI * 0.4,
      rotSpeed: (Math.random() - 0.5) * 0.25,
      opacity: 0.18 + Math.random() * 0.32,
      type: type,
      // Smoothed displacement applied on top of (x, y) by the mouse-
      // repulsion pass. Stored on the particle so the eased return-to-zero
      // doesn't snap when the cursor leaves the influence radius.
      offsetX: 0,
      offsetY: 0,
    };
  }

  function init() {
    var canvas = document.getElementById("gv-auth-bg");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    var reduceMotion = mq.matches;

    var sprites = buildSprites();
    var particles = [];
    var width = 0;
    var height = 0;
    // Cursor in CSS-pixel coordinates relative to the viewport. -1 sentinel
    // means "no active cursor" (initial state or pointer left the window) so
    // the eased offset returns to zero without a hard snap.
    var mouseX = -1;
    var mouseY = -1;
    // Wheel-controlled fall-speed multiplier. Applied uniformly in the
    // tick to every particle's vertical velocity; rotation and sway are
    // left alone so the motion stays legible at high speed.
    var speedMultiplier = 1;

    function resize() {
      var prevWidth = width;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Redistribute existing particles' x so they keep covering the full
      // width after a window resize — otherwise enlarging the viewport
      // leaves the icons bunched in the original column.
      if (prevWidth > 0 && prevWidth !== width) {
        var xScale = width / prevWidth;
        for (var j = 0; j < particles.length; j++) {
          particles[j].x *= xScale;
        }
      }

      var target = Math.min(110, Math.max(28, Math.round((width * height) / 22000)));
      if (particles.length === 0) {
        for (var i = 0; i < target; i++) {
          particles.push(makeParticle(width, height, false));
        }
      } else if (particles.length < target) {
        while (particles.length < target) {
          particles.push(makeParticle(width, height, true));
        }
      } else if (particles.length > target) {
        particles.length = target;
      }
    }

    function draw(t) {
      ctx.clearRect(0, 0, width, height);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var drawSize = SPRITE_SIZE * p.scale;
        // Vertical-position opacity ramp: fully present near the top of
        // the viewport, fading toward the bottom. Clamped to [0, 1] so
        // off-screen positions don't blow up or go negative.
        var yFrac = Math.max(0, Math.min(1, p.y / height));
        var op = p.opacity * (1.25 - yFrac * 1.1);
        ctx.save();
        ctx.globalAlpha = op;
        ctx.translate(
          p.x + p.offsetX + Math.sin(t / 1200 + p.swayPhase) * p.sway,
          p.y + p.offsetY,
        );
        ctx.rotate(p.rotation);
        ctx.drawImage(
          sprites[p.type],
          -drawSize / 2,
          -drawSize / 2,
          drawSize,
          drawSize,
        );
        ctx.restore();
      }
    }

    var lastTs = performance.now();
    var rafId = 0;

    function tick(ts) {
      var dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      // Framerate-independent easing factor for the cursor-offset low-pass.
      // 1 − exp(−dt · k) converges to the target with time constant 1/k
      // regardless of frame timing; k = 6 → ~95 % settled in 0.5 s.
      var easing = 1 - Math.exp(-dt * 6);
      var cursorActive = mouseX >= 0 && mouseY >= 0;
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.y += p.speed * dt * speedMultiplier;
        p.rotation += p.rotSpeed * dt;
        if (p.y - SPRITE_SIZE > height) {
          var fresh = makeParticle(width, height, true);
          p.x = fresh.x;
          p.y = fresh.y;
          p.scale = fresh.scale;
          p.speed = fresh.speed;
          p.sway = fresh.sway;
          p.swayPhase = fresh.swayPhase;
          p.rotation = fresh.rotation;
          p.rotSpeed = fresh.rotSpeed;
          p.opacity = fresh.opacity;
          p.type = fresh.type;
          p.offsetX = 0;
          p.offsetY = 0;
        }
        // Compute the cursor-repulsion target. Quadratic falloff inside the
        // radius, zero outside. The eased offset converges toward this every
        // frame, so leaving the cursor stationary lets icons settle and
        // leaving the window resets the target to zero (smooth return).
        var targetOx = 0;
        var targetOy = 0;
        if (cursorActive) {
          var dx = p.x - mouseX;
          var dy = p.y - mouseY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0 && dist < REPEL_RADIUS) {
            var f = 1 - dist / REPEL_RADIUS;
            var falloff = f * f;
            targetOx = (dx / dist) * falloff * REPEL_STRENGTH;
            targetOy = (dy / dist) * falloff * REPEL_STRENGTH;
          }
        }
        p.offsetX += (targetOx - p.offsetX) * easing;
        p.offsetY += (targetOy - p.offsetY) * easing;
      }
      draw(ts);
      rafId = requestAnimationFrame(tick);
    }

    resize();

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = requestAnimationFrame(tick);
    }

    function onMotionChange(e) {
      var next = e.matches;
      if (next === reduceMotion) return;
      reduceMotion = next;
      if (reduceMotion) {
        cancelAnimationFrame(rafId);
        draw(0);
      } else {
        lastTs = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    }

    // Cursor tracking — only meaningful when motion is allowed; under
    // reduce-motion the canvas paints a single static frame and there is
    // no rAF loop to consume the position.
    function onPointerMove(e) {
      if (reduceMotion) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
    }
    function onPointerLeave() {
      mouseX = -1;
      mouseY = -1;
    }

    // Wheel-driven speed control. Registered passively so the browser's
    // native scroll behaviour on the page (when there's overflow) is
    // unaffected — we *also* react to the wheel, we don't capture it.
    // Wheel down (deltaY > 0) accelerates the fall, wheel up slows it.
    function onWheel(e) {
      if (reduceMotion) return;
      var factor = Math.exp(e.deltaY * SPEED_SENSITIVITY);
      speedMultiplier = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speedMultiplier * factor));
    }

    // Re-kick the rAF loop whenever the page becomes active again.
    //
    // Two restore paths to cover:
    //   - bfcache (`pageshow` with persisted=true): Chrome can freeze
    //     this Keycloak page in memory when the user goes back to the
    //     SPA and resume it on forward (or vice-versa). The pending rAF
    //     callback is sometimes never delivered after the freeze.
    //   - `visibilitychange` to "visible": covers tab switches and the
    //     case where bfcache is disqualified (HMR WebSockets, certain
    //     cache headers) and a full re-render happens — the freshly
    //     registered rAF can still race with the document becoming
    //     visible.
    //
    // `cancelAnimationFrame` on a stale handle is harmless, so both
    // handlers can blindly restart the loop.
    function ensureRunning() {
      if (reduceMotion) return;
      cancelAnimationFrame(rafId);
      lastTs = performance.now();
      rafId = requestAnimationFrame(tick);
    }
    function onPageShow(e) {
      if (e.persisted) ensureRunning();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") ensureRunning();
    }

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (mq.addEventListener) {
      mq.addEventListener("change", onMotionChange);
    } else if (mq.addListener) {
      mq.addListener(onMotionChange);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
