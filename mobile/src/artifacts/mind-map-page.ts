/**
 * The Mind Constellation's drawing, as a page for a WebView: one <canvas> the browser redraws on the GPU every frame
 * while the map moves, so it is sharp at every step of a flight and its memory is one screen-sized canvas. The camera,
 * the finger gestures and the flights all run here, so nothing crosses to React Native per frame.
 *
 * In (window.__mm): { scene } a new layout (flies to the whole figure), { layout: { sheetH, embedded, warp } },
 * { focus: index | -1 } fly to a star (-1: everything), { zoom: factor }.
 * Out (postMessage): { ready: true } once listening, { focused: index | -1 } when a tap changed the focus.
 *
 * The drawing follows the explorer's SVG drawing it replaces (mind-map.tsx), from the same layout (mindLayout.ts).
 */
export const MIND_MAP_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; -webkit-user-select: none; user-select: none; }
  canvas { display: block; width: 100vw; height: 100vh; touch-action: none; -webkit-tap-highlight-color: transparent; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(function () {
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var S = null; // the scene: stars, edges, boxes, extent, orbit, and the layout's constants
  var W = 0, H = 0, dpr = 1;
  var sheetH = 0, embedded = false, warp = true, entered = false;
  var cam = { x: 0, y: 0, s: 0.1 };
  var fromF = null, toF = null, focusT = 1, focusIdx = -1;
  var flight = null;
  var glows = [], core = null;
  var queued = false;

  function send(msg) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function ramp(v, a, b) { return clamp((v - a) / (b - a), 0, 1); }

  /* cubic-bezier(0.45, 0, 0.2, 1): a soft start and a long, easy landing */
  function bezier(x1, y1, x2, y2) {
    function a(p1, p2) { return 1 - 3 * p2 + 3 * p1; }
    function b(p1, p2) { return 3 * p2 - 6 * p1; }
    function c(p1) { return 3 * p1; }
    function at(t, p1, p2) { return ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t; }
    function slope(t, p1, p2) { return 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1); }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var d = at(t, x1, x2) - x;
        var sl = slope(t, x1, x2);
        if (Math.abs(d) < 1e-5 || sl === 0) break;
        t -= d / sl;
      }
      return at(clamp(t, 0, 1), y1, y2);
    };
  }
  var ease = bezier(0.45, 0, 0.2, 1);

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  }

  function makeGradients() {
    var C = S.consts;
    var tint = function (hex, a) {
      var n = parseInt(hex.slice(1), 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
    };
    glows = C.ACCENTS.concat([C.CORE]).map(function (c) {
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, tint(c, 0.95));
      g.addColorStop(0.3, tint(c, 0.4));
      g.addColorStop(1, tint(c, 0));
      return g;
    });
    core = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(0.3, "#dbe8ff");
    core.addColorStop(0.65, "rgba(122,167,255,0.9)");
    core.addColorStop(1, "rgba(33,124,255,0)");
  }

  /* Who is in focus: the star, its lineage and everything orbiting it (all of it at the centre). */
  function focusState(idx) {
    var n = S.stars.length;
    var mask = new Array(n);
    if (idx <= 0) { for (var i = 0; i < n; i++) mask[i] = 1; return { mask: mask, idx: -1, flow: 0 }; }
    var lineage = {};
    for (var c = idx; c >= 0; c = S.stars[c].parent) lineage[c] = 1;
    for (var j = 0; j < n; j++) {
      var on = 0;
      if (lineage[j]) on = 1;
      else for (var k = j; k >= 0; k = S.stars[k].parent) if (k === idx) { on = 1; break; }
      mask[j] = on;
    }
    return { mask: mask, idx: idx, flow: 1 };
  }

  function boxH() { return Math.max(1, H - (embedded ? 0 : sheetH + 24)); }
  /* Where the camera sits to frame a star and everything orbiting it, a little above the details sheet. */
  function frameOf(idx) {
    var i = idx < 0 ? 0 : idx;
    var b = S.boxes[i];
    var level = S.stars[i].level;
    var pad = level === 0 ? 70 : level === 3 ? 56 : 46;
    var bh = boxH();
    var s = clamp(Math.min(W / (2 * Math.max((b[1] - b[0]) / 2 + pad, 60)), bh / (2 * Math.max((b[3] - b[2]) / 2 + pad, 60))), 0.02, S.consts.MAX_SCALE);
    var dy = embedded ? 0 : (H - bh) / 2 / s;
    return { x: (b[0] + b[1]) / 2, y: (b[2] + b[3]) / 2 + dy, s: s };
  }
  function fit() { var f = frameOf(-1); return f.s; }

  /* Fly: pan and zoom on one curve, the zoom moving geometrically. A new flight takes over from where the camera is. */
  function flyTo(to, ms, focusing) {
    var trip = Math.abs(Math.log(to.s) - Math.log(cam.s)) + Math.min(2, (Math.hypot(to.x - cam.x, to.y - cam.y) * Math.min(cam.s, to.s)) / Math.max(W, 1));
    flight = {
      x0: cam.x, y0: cam.y, l0: Math.log(cam.s),
      x1: to.x, y1: to.y, l1: Math.log(to.s),
      start: performance.now(),
      dur: ms || clamp(620 + 260 * trip, 700, 1150),
      focusing: !!focusing,
    };
    tick();
  }
  function focus(idx, ms) {
    fromF = toF;
    toF = focusState(idx);
    focusIdx = toF.idx;
    focusT = 0;
    flyTo(frameOf(idx), ms, true);
  }
  function zoomBy(factor, fx, fy) {
    if (fx === undefined) { fx = W / 2; fy = H / 2; }
    var s0 = cam.s;
    var s = clamp(s0 * factor, fit() * 0.5, S.consts.MAX_SCALE);
    var wx = cam.x + (fx - W / 2) / s0;
    var wy = cam.y + (fy - H / 2) / s0;
    flyTo({ s: s, x: wx - (fx - W / 2) / s, y: wy - (fy - H / 2) / s }, 260, false);
  }

  function tick() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      if (flight) {
        var t = clamp((performance.now() - flight.start) / flight.dur, 0, 1);
        var e = ease(t);
        cam.x = flight.x0 + (flight.x1 - flight.x0) * e;
        cam.y = flight.y0 + (flight.y1 - flight.y0) * e;
        cam.s = Math.exp(flight.l0 + (flight.l1 - flight.l0) * e);
        if (flight.focusing) focusT = e;
        if (t >= 1) { if (flight.focusing) focusT = 1; flight = null; }
      }
      draw();
      if (flight) tick();
    });
  }
  /* A finger took the camera: stop flying, and let the focus land where it was heading. */
  function grab() { if (flight) { if (flight.focusing) focusT = 1; flight = null; } }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!S || !toF || !W) return;
    var C = S.consts, stars = S.stars, s = cam.s, f0 = fit();
    var z = s / f0;
    var levelOp = [1, 1, ramp(z, 1.25, 1.8), ramp(z, 3.6, 5)];
    var from = fromF || toF, to = toF, t = focusT;
    var sx = function (x) { return W / 2 + (x - cam.x) * s; };
    var sy = function (y) { return H / 2 + (y - cam.y) * s; };
    var onCanvas = function (x, y, r) { return x + r > 0 && x - r < W && y + r > 0 && y - r < H; };
    var focusOf = function (i) { return from.mask[i] + (to.mask[i] - from.mask[i]) * t; };
    var flowOf = function (i) { return from.flow * from.mask[i] * (1 - t) + to.flow * to.mask[i] * t; };
    var focusedness = function (i) { return (to.idx === i ? t : 0) + (from.idx === i ? 1 - t : 0); };
    var labelPx = function (level) { return C.LABEL_PX[level] * Math.pow(s, 0.3) * (level === 0 ? 0.82 : 1); };
    var glowAt = function (g, x, y, r, alpha) {
      if (alpha < 0.005 || r <= 0) return;
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.translate(x, y);
      ctx.scale(r, r);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    var disc = function (x, y, r, color, alpha) {
      if (alpha <= 0) return;
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    var ring = function (x, y, r, color, alpha, width, dash) {
      if (alpha <= 0) return;
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // A sky of faint stars, fixed to the screen.
    for (var k = 0; k < C.SKY.length; k++) {
      var st = C.SKY[k];
      disc(st.x * W + st.r, st.y * H + st.r, st.r, st.blue ? "#a9c8ff" : "#fff", st.o);
    }
    // Nebula: a soft cloud behind the whole map and each theme.
    glowAt(glows[C.ACCENTS.length], sx(0), sy(0), S.extent * 1.7 * s, 0.22);
    stars.forEach(function (p, i) {
      var r = C.TOPIC_ORBIT * 2.3 * s;
      if (p.level === 1 && onCanvas(sx(p.x), sy(p.y), r)) glowAt(glows[p.branch % C.ACCENTS.length], sx(p.x), sy(p.y), r, 0.1 + 0.2 * focusOf(i));
    });
    // Orbits (the Orbit shape).
    if (S.orbit) {
      stars.forEach(function (p, i) {
        if (!p.kids || p.level > 2) return;
        var r = (p.level === 0 ? S.extent : p.level === 1 ? C.TOPIC_ORBIT : C.DETAIL_ORBIT) * s;
        var op = levelOp[p.level + 1] * (0.3 + 0.7 * focusOf(i)) * 0.3;
        if (op < 0.01 || !onCanvas(sx(p.x), sy(p.y), r)) return;
        ring(sx(p.x), sy(p.y), r, p.level === 0 ? "#8fbaff" : p.color, op, 1);
      });
    }
    // Constellation lines: those into the focused family flow (dashed).
    S.edges.forEach(function (e) {
      var end = stars[e.to];
      var lo = levelOp[end.level];
      if (lo <= 0.03) return;
      var fl = flowOf(e.to);
      ctx.globalAlpha = clamp(lo * (0.16 + 0.44 * focusOf(e.to) + 0.3 * fl) * (e.faint ? 0.4 : 1), 0, 1);
      ctx.strokeStyle = end.color;
      ctx.lineWidth = 1 + 0.4 * fl;
      ctx.setLineDash(fl > 0.5 ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(sx(stars[e.a].x), sy(stars[e.a].y));
      ctx.lineTo(sx(stars[e.b].x), sy(stars[e.b].y));
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Declutter, as the web: a bigger or more central star claims its label's space; one that would overlap is hidden.
    var hidden = {}, kept = [], claims = [];
    stars.forEach(function (p, i) {
      if (levelOp[p.level] * (0.28 + 0.72 * focusOf(i)) < 0.3) return;
      var fs = labelPx(p.level);
      var bw = Math.min(p.text.length, p.level >= 2 ? 16 : 14) * fs * 0.58;
      var top = sy(p.y) + C.RADIUS[p.level] * s * 1.35;
      var box = [sx(p.x) - bw / 2, sx(p.x) + bw / 2, top, top + fs * 1.3];
      claims.push({ i: i, level: p.level, d: Math.pow(box[0] + box[1] - W, 2) + Math.pow(box[2] + box[3] - H, 2), box: box });
    });
    claims.sort(function (a, b) { return a.level - b.level || a.d - b.d; });
    claims.forEach(function (c) {
      var b = c.box;
      var free = kept.every(function (q) { return !(b[0] < q[1] && b[1] > q[0] && b[2] < q[3] && b[3] > q[2]); });
      if (c.i === to.idx || free) kept.push(b);
      else hidden[c.i] = true;
    });

    // Stars, deepest first, so the outer stars' labels stay on top.
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (var i = stars.length - 1; i >= 0; i--) {
      var p = stars[i];
      var op = levelOp[p.level] * (0.28 + 0.72 * focusOf(i));
      var x = sx(p.x), y = sy(p.y), r = C.RADIUS[p.level] * s;
      if (op < 0.02 || !onCanvas(x, y, Math.max(r * 4, 120))) continue;
      var fs = labelPx(p.level);
      var ff = focusedness(i);
      glowAt(glows[p.level === 0 ? C.ACCENTS.length : p.branch % C.ACCENTS.length], x, y, r * (p.level === 0 ? 4 : 3.4), 0.8 * op);
      if (p.level < 2) {
        var spike = r * (p.level === 0 ? 4.6 : 3.2);
        ctx.globalAlpha = clamp(0.38 * op, 0, 1);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(x - spike, y); ctx.lineTo(x + spike, y);
        ctx.moveTo(x, y - spike); ctx.lineTo(x, y + spike);
        ctx.stroke();
      }
      if (p.level === 0) {
        ring(x, y, r * 1.75, "#bcd6ff", 0.5 * op, 1, [2, 6]);
        ring(x, y, r * 2.4, "#bcd6ff", 0.3 * op, 1, [2, 6]);
        glowAt(core, x, y, r, op);
        disc(x, y, r * 0.38, "#fff", op);
      } else {
        // The plain star, and over it the focused look, faded by how focused it is, so a change of focus blends.
        disc(x, y, r, p.level === 1 ? p.color : p.level === 2 ? "#1c3f86" : "#fff", op);
        if (p.level < 3) ring(x, y, r, p.level === 1 ? "#fff" : p.color, op * (1 - ff) * (p.level === 1 ? 0.7 : 1), p.level === 2 ? 1.8 : 1.5);
        if (ff > 0) {
          disc(x, y, r, "#fff", op * ff);
          ring(x, y, r, "#8fbaff", op * ff, 3);
          ring(x, y, r * 2.3, p.color, op * ff, 1.5);
        }
        disc(x, y, r * 0.42, p.level === 2 ? p.color : "#fff", op * (p.level === 2 ? 1 - ff : 1));
        if (p.level === 2 && ff > 0) disc(x, y, r * 0.42, "#fff", op * ff);
      }
      var more = p.kids * (1 - (p.level < 3 ? levelOp[p.level + 1] : 1));
      if (more > 0.2 && p.level > 0) {
        ctx.globalAlpha = clamp(op * (more / Math.max(p.kids, 1)), 0, 1);
        ctx.fillStyle = "#8fbaff";
        ctx.textAlign = "left";
        ctx.font = "500 " + fs * 0.7 + "px 'Space Grotesk', system-ui, sans-serif";
        ctx.fillText("+" + p.kids, x + r * 1.1, y - r * 1.1);
        ctx.textAlign = "center";
      }
      var labelY = y + r * 1.35 + fs * 1.15;
      if (!hidden[i]) {
        ctx.font = (p.level <= 1 ? "700 " : "500 ") + fs + "px 'Space Grotesk', system-ui, sans-serif";
        if ("letterSpacing" in ctx) ctx.letterSpacing = p.level === 0 ? fs * 0.14 + "px" : "0px";
        ctx.globalAlpha = clamp(op, 0, 1);
        ctx.strokeStyle = "#000";
        ctx.lineWidth = fs * 0.22;
        p.lines.forEach(function (l, n) { ctx.strokeText(l, x, labelY + n * fs * 1.12); });
        ctx.globalAlpha = clamp(op * (p.level === 3 ? 0.88 : 1), 0, 1);
        ctx.fillStyle = "#fff";
        p.lines.forEach(function (l, n) { ctx.fillText(l, x, labelY + n * fs * 1.12); });
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      }
      var noteOp = p.notes.length ? ramp(z, 6, 8) : 0;
      if (noteOp > 0.05) {
        var ns = Math.min(fs * 0.82, 3.4 * s);
        ctx.font = "500 " + ns + "px 'Space Grotesk', system-ui, sans-serif";
        ctx.globalAlpha = clamp(0.78 * op * noteOp, 0, 1);
        ctx.fillStyle = "#fff";
        p.notes.forEach(function (l, n) { ctx.fillText(l, x, labelY + p.lines.length * fs * 1.12 + ns * (0.8 + n * 1.2)); });
      }
    }
    ctx.globalAlpha = 1;
  }

  /* A tap picks the nearest star in view, if it is close enough to the finger. The focused star, tapped again, lets go. */
  function tapAt(tx, ty) {
    if (!S) return;
    var s = cam.s, z = s / fit();
    var levelOp = [1, 1, ramp(z, 1.25, 1.8), ramp(z, 3.6, 5)];
    var best = -1, bestD = Infinity;
    S.stars.forEach(function (p, i) {
      if (levelOp[p.level] < 0.3) return;
      var d = Math.hypot(W / 2 + (p.x - cam.x) * s - tx, H / 2 + (p.y - cam.y) * s - ty);
      if (d < Math.max(S.consts.RADIUS[p.level] * s * 2, 22) && d < bestD) { best = i; bestD = d; }
    });
    if (best < 0) return;
    var next = best === focusIdx || S.stars[best].level === 0 ? -1 : best;
    focus(next);
    send({ focused: next });
  }

  /* Fingers: one drags, two pinch around their midpoint; a short still touch taps, two quick ones zoom in. */
  var touches = null, moved = 0, startAt = 0, lastTap = null, tapTimer = null;
  function pts(e) { return Array.prototype.map.call(e.touches, function (q) { return { x: q.clientX, y: q.clientY }; }); }
  canvas.addEventListener("touchstart", function (e) {
    e.preventDefault();
    if (embedded) return;
    grab();
    touches = pts(e);
    if (e.touches.length === 1) { moved = 0; startAt = performance.now(); }
    else moved = 99;
  }, { passive: false });
  canvas.addEventListener("touchmove", function (e) {
    e.preventDefault();
    if (embedded || !touches || !S) return;
    var now = pts(e);
    if (now.length === 1 && touches.length === 1) {
      var dx = now[0].x - touches[0].x, dy = now[0].y - touches[0].y;
      moved += Math.abs(dx) + Math.abs(dy);
      cam.x -= dx / cam.s;
      cam.y -= dy / cam.s;
    } else if (now.length >= 2 && touches.length >= 2) {
      var d0 = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
      var d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
      var mx0 = (touches[0].x + touches[1].x) / 2, my0 = (touches[0].y + touches[1].y) / 2;
      var mx = (now[0].x + now[1].x) / 2, my = (now[0].y + now[1].y) / 2;
      var s0 = cam.s;
      var s1 = clamp(s0 * (d0 > 0 ? d1 / d0 : 1), fit() * 0.5, S.consts.MAX_SCALE);
      // Keep the world point under the fingers under them, and follow the fingers as they move.
      var wx = cam.x + (mx0 - W / 2) / s0, wy = cam.y + (my0 - H / 2) / s0;
      cam.s = s1;
      cam.x = wx - (mx - W / 2) / s1;
      cam.y = wy - (my - H / 2) / s1;
    }
    touches = now;
    tick();
  }, { passive: false });
  canvas.addEventListener("touchend", function (e) {
    e.preventDefault();
    if (embedded) return;
    if (e.touches.length) { touches = pts(e); moved = 99; return; }
    var t = e.changedTouches[0];
    touches = null;
    if (moved > 10 || performance.now() - startAt > 350) return;
    var here = { x: t.clientX, y: t.clientY, at: performance.now() };
    if (lastTap && here.at - lastTap.at < 280 && Math.hypot(here.x - lastTap.x, here.y - lastTap.y) < 30) {
      clearTimeout(tapTimer);
      lastTap = null;
      zoomBy(1.8, here.x, here.y);
      return;
    }
    lastTap = here;
    tapTimer = setTimeout(function () { lastTap = null; tapAt(here.x, here.y); }, 230);
  }, { passive: false });

  /* Warp in: from far out, fly to the whole constellation (in a report, it simply sits there). */
  function enter() {
    if (entered || !S || !W) return;
    entered = true;
    var end = frameOf(-1);
    cam = { x: end.x, y: end.y, s: warp ? end.s * 0.25 : end.s };
    if (warp) flyTo(end, 1400, false);
  }

  window.__mm = function (msg) {
    if (msg.layout) {
      sheetH = msg.layout.sheetH;
      embedded = !!msg.layout.embedded;
      warp = msg.layout.warp !== false;
    }
    if (msg.scene) {
      S = msg.scene;
      makeGradients();
      var all = focusState(-1);
      fromF = all;
      toF = all;
      focusT = 1;
      focusIdx = -1;
      if (!entered) enter();
      else if (W) flyTo(frameOf(-1), 900, false);
      send({ focused: -1 });
    }
    if (msg.focus !== undefined && S) focus(msg.focus);
    if (msg.zoom && S) zoomBy(msg.zoom);
    draw();
  };

  window.addEventListener("resize", function () {
    var wasW = W;
    resize();
    enter();
    if (S && wasW && Math.abs(W - wasW) > 1) flyTo(frameOf(focusIdx), 400, false);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  resize();
  send({ ready: true });
})();
</script>
</body>
</html>`;
