// The node globe — the network map's hero visual.
//
// A dot-matrix Earth (land only, baked in app/assets/landdots.json) carrying a
// live marker for every node the explorer's own node is peered with, plus an
// arc from that vantage node out to each peer. Markers behind the globe are
// occluded by a real depth-writing sphere rather than faked, so the thing reads
// as a physical object you can spin.
//
// Placement is COUNTRY-level by design (see the API's geo module): a marker
// sits at its country's centroid, spread within a small cluster when a country
// holds several nodes. It is not, and must not look like, a street address.
//
// Self-contained three.js: nothing fetched at runtime, sprites are canvas-drawn,
// drag-to-spin with inertia, and the loop parks itself when the canvas is
// off-screen or the tab is hidden.

import landDots from "../assets/landdots.json";
import { useEffect, useRef } from "react";
import * as THREE from "three";

const TEAL = "#17d6be";
const BRIGHT = "#7ef7e4";
/** Minimum vertical distance between two overlapping country labels, in px. */
const LABEL_GAP = 17;
/** How far the declutter pass may push a label from its country before the label
 * is dropped instead. Past this it is no longer pointing at anything. */
const MAX_LABEL_SHIFT = 46;
/** Below this VIEWPORT width a country label is a flag and a count, with no name.
 * Deliberately the viewport and not the canvas: the globe sits in a panel that is
 * comfortably under 640px even on a large desktop, so measuring the canvas hid the
 * country names on exactly the screens with room for them. What matters is whether
 * this is a phone. */
const COMPACT_LABEL_WIDTH = 640;
const isCompactViewport = () =>
  typeof window !== "undefined" && window.matchMedia(`(max-width: ${COMPACT_LABEL_WIDTH - 1}px)`).matches;
/** Radians of spin for a drag across the FULL canvas width/height. Expressed as a
 * fraction of the canvas rather than per-pixel so a maximised window and a small
 * one feel identical — per-pixel sensitivity made the globe feel sluggish on a
 * large display and twitchy on a small one. */
const DRAG_SPAN_X = 5.0;
const DRAG_SPAN_Y = 3.0;
/** Fraction of the spin velocity surviving one second of coasting. */
const SPIN_DAMPING = 0.025;
/** Ceiling on flick speed, rad/s — a violent drag should not turn into a blur. */
const MAX_SPIN = 9;
/** Below this spin rate (rad/s) the globe is treated as stopped. */
const SPIN_EPSILON = 0.01;
/** A drag that has been still for longer than this releases with NO momentum:
 * lining up a country and letting go must not fling the globe away. */
const STALE_FLICK_MS = 90;

/** One node as the globe needs it. */
export interface GlobeNode {
  id: string;
  lat: number | null;
  lon: number | null;
  self: boolean;
  country: string | null;
}

/** A country label pinned to the globe — shown always, not just on hover. */
export interface GlobeLabel {
  code: string;
  name: string;
  count: number;
  lat: number;
  lon: number;
}

/** One block from the live feed, as the globe needs it. */
export interface GlobeBlock {
  hash: string;
  blue: number;
  txs: number;
}

/** One transaction from the live feed, with the facts the globe narrates.
 *  Everything here is read off the chain — nothing is invented for effect. */
export interface GlobeTx {
  id: string;
  /** Orchard actions in the bundle = spends proven + notes created. */
  actions: number;
}

interface Props {
  nodes: GlobeNode[];
  labels: GlobeLabel[];
  /** Currently highlighted node id (hover in the table, or on the globe). */
  activeId?: string | null;
  onHover?: (id: string | null, screen?: { x: number; y: number }) => void;
  onSelect?: (id: string) => void;
  /** Live shielded transfers — each new one is relayed out of the vantage node. */
  txs?: GlobeTx[];
  /** Live blocks — each new one flashes the atmosphere and floats a pill. */
  blocks?: GlobeBlock[];
  /** SPA navigation for the clickable tags. */
  onNavigate?: (to: string) => void;
}

const HEXC = "0123456789abcdef";
const randHex = () => HEXC[Math.floor(Math.random() * 16)];

/** What a hash looks like at age t∈[0,1]: flicker → resolve to the REAL id.
 *  It stays resolved (and clickable) so people can see this is live chain
 *  data, not decoration. */
function hashDisplay(id: string, t: number): string {
  if (t < 0.28) return id.replace(/./g, randHex); // flickering ciphertext
  if (t < 0.42) {
    const k = Math.floor(((t - 0.28) / 0.14) * id.length);
    return id.slice(0, k) + id.slice(k).replace(/./g, randHex); // resolving
  }
  return id;
}

// Ambient telemetry, shown only when the chain is quiet. Each line is templated
// from the last block the globe actually saw, so even the filler is true: at
// 1 BPS every block mints one coinbase note and carries a fresh state root.
const AMBIENT: ((b: GlobeBlock | null) => string)[] = [
  (b) => (b ? `note commitment ⊕ #${b.blue.toLocaleString("en-US")}` : "note commitment ⊕"),
  () => "sinsemilla · anchor ✓",
  () => "kHeavyHash · live work",
  () => "private transaction relay",
  (b) => (b ? `${b.txs} tx · amounts sealed` : "amounts sealed"),
  () => "peers: relaying ✓",
];

/** ISO-3166-1 alpha-2 → regional-indicator flag emoji. */
const flagOf = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";

/** Lat/lon (degrees) → a point on a sphere of radius `r`. */
function latLonToVec3(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

/** Soft round sprite, drawn on a canvas so nothing is fetched. */
function discTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** A node marker: white-hot core inside a teal glow, baked into ONE sprite.
 *  Two stacked sprites per node looked the same and cost a draw call each. */
function markerTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.14, "#ffffff");
  g.addColorStop(0.3, BRIGHT);
  g.addColorStop(0.55, "rgba(126,247,228,0.45)");
  g.addColorStop(1, "rgba(126,247,228,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Thin glowing ring, for the radar pulse each node emits. */
function ringTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = BRIGHT;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

export default function NodeGlobe({ nodes, labels, activeId, onHover, onSelect, txs, blocks, onNavigate }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  // The render loop reads these through refs so new node data never rebuilds
  // the whole scene (and never restarts the spin).
  const nodesRef = useRef(nodes);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const activeRef = useRef(activeId);
  const hoverCb = useRef(onHover);
  const selectCb = useRef(onSelect);
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  /** Set by the scene effect; lets the data effects below drive the scene. */
  const rebuildRef = useRef<(() => void) | null>(null);
  const spawnTxRef = useRef<((tx: GlobeTx) => void) | null>(null);
  const spawnBlockRef = useRef<((b: GlobeBlock) => void) | null>(null);
  nodesRef.current = nodes;
  activeRef.current = activeId;
  hoverCb.current = onHover;
  selectCb.current = onSelect;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 3.1);

    // Everything on this globe is a point, a sprite or a thin line, so MSAA buys
    // almost nothing while costing a full multisampled buffer. Take it only on
    // low-density screens, where stair-stepping would actually show.
    const dpr = window.devicePixelRatio || 1;
    const narrow = mount.clientWidth > 0 && mount.clientWidth < 640;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: dpr < 1.5, alpha: true, powerPreference: "low-power" });
    } catch {
      return; // No WebGL — the page still works, it just has no globe.
    }
    // 1.75 rather than 2: on a 3x phone the extra pixels are invisible and the
    // fill cost of the additive sprites is not.
    renderer.setPixelRatio(Math.min(dpr, 1.75));
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    mount.appendChild(canvas);

    // `group` carries the whole planet, so spinning it spins land, markers and
    // arcs together.
    const group = new THREE.Group();
    scene.add(group);

    // --- The planet ----------------------------------------------------------
    // An opaque, near-black sphere just inside the dot shell. It writes depth,
    // which is what occludes markers and arcs on the far side.
    // It is never seen directly (the dot shell sits on top of it), so a coarse
    // tessellation is indistinguishable and a quarter of the triangles.
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(0.985, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x0a0f16 }),
    );
    group.add(globe);

    // Fresnel rim: a back-facing shell that glows only where it grazes the
    // silhouette, which reads as atmosphere.
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.16, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(TEAL) }, uBoost: { value: 0 } },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uColor;
          uniform float uBoost;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float rim = 1.0 - abs(dot(vNormal, vView));
            float a = pow(rim, 3.4) * (0.55 + uBoost * 1.1);
            gl_FragColor = vec4(uColor, a);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    group.add(atmosphere);

    // (No halo sprite here on purpose. A soft disc wide enough to glow around
    // the planet covers most of the viewport, and blending a near-fullscreen
    // quad every frame is the single most expensive thing this scene can do on
    // integrated graphics — for an effect the Fresnel rim already gives.)

    // Starfield: a slow, faint backdrop that gives the spin a sense of depth.
    // It lives on `scene`, not `group`, so it drifts independently of the globe.
    const STARS = narrow ? 70 : 140;
    const starPos = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(7 + Math.random() * 4);
      starPos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starTex = discTexture("rgba(200,215,235,0.9)", "rgba(200,215,235,0)");
    const starMat = new THREE.PointsMaterial({
      size: 0.07,
      map: starTex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      color: 0xb9c6dc,
    });
    const stars = new THREE.Points(starGeom, starMat);
    stars.frustumCulled = false;
    scene.add(stars);

    // Graticule: meridians and parallels every 30°, barely there. It reads as a
    // globe rather than a ball of dots, and gives the rotation something to
    // register against.
    const gratPts: number[] = [];
    const ring = (fixedLat: number | null, fixedLon: number | null) => {
      const STEP = 6;
      for (let a = 0; a < 360; a += STEP) {
        const p1 = fixedLat != null ? latLonToVec3(fixedLat, a, 0.992) : latLonToVec3(a - 180, fixedLon!, 0.992);
        const p2 =
          fixedLat != null ? latLonToVec3(fixedLat, a + STEP, 0.992) : latLonToVec3(a + STEP - 180, fixedLon!, 0.992);
        gratPts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    };
    for (let lat = -60; lat <= 60; lat += 30) ring(lat, null);
    for (let lon = -180; lon < 180; lon += 30) ring(null, lon);
    const gratGeom = new THREE.BufferGeometry();
    gratGeom.setAttribute("position", new THREE.Float32BufferAttribute(gratPts, 3));
    const gratMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(TEAL),
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
    });
    group.add(new THREE.LineSegments(gratGeom, gratMat));

    // --- Land dot matrix -----------------------------------------------------
    // Drawn with a small shader rather than PointsMaterial so each dot can vary
    // in brightness and, crucially, DIM TOWARD THE LIMB. Flat-lit dots make a
    // sphere look like a flat sticker; falling off at the edge is what sells the
    // curvature.
    //
    // On a phone the whole planet is ~350px across, so half the dots land on the
    // same pixel: stride them and halve the vertex + fill cost for free.
    const all = landDots as [number, number][];
    const stride = narrow ? 2 : 1;
    const count = Math.ceil(all.length / stride);
    const dotPos = new Float32Array(count * 3);
    const dotRand = new Float32Array(count);
    for (let i = 0, j = 0; i < all.length; i += stride, j++) {
      const v = latLonToVec3(all[i][0], all[i][1], 1.0);
      dotPos.set([v.x, v.y, v.z], j * 3);
      dotRand[j] = Math.random();
    }
    const dotGeom = new THREE.BufferGeometry();
    dotGeom.setAttribute("position", new THREE.BufferAttribute(dotPos, 3));
    dotGeom.setAttribute("aRand", new THREE.BufferAttribute(dotRand, 1));
    const dotMat = new THREE.ShaderMaterial({
      uniforms: {
        // Two-tone teal, the palette the globe shipped with (#37c9b5): land is
        // brand-coloured, not a grey-white map dropped on a dark page. The dim
        // tone takes over toward the limb, so the falloff reads as the planet
        // curving away instead of the dots just getting fainter.
        uDim: { value: new THREE.Color(0x1a7f74) },
        uLit: { value: new THREE.Color(0x4fe0ca) },
        // Half the drawing-buffer height: the same factor three.js's own
        // PointsMaterial uses for size attenuation, which lets uSize stay in
        // WORLD units (~0.028, as the globe originally shipped). Getting this
        // wrong is what turned the dot matrix into one solid glowing blob —
        // a hardcoded pixel constant made every dot ~100px across.
        uScale: { value: 300 },
        uSize: { value: stride > 1 ? 0.036 : 0.028 },
      },
      vertexShader: `
        attribute float aRand;
        uniform float uScale;
        uniform float uSize;
        varying float vShade;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // On a unit sphere the position IS the normal.
          vec3 n = normalize(normalMatrix * normalize(position));
          float facing = dot(n, normalize(-mv.xyz));
          vShade = smoothstep(0.0, 0.55, facing) * (0.5 + aRand * 0.5);
          gl_PointSize = (uSize * (0.8 + aRand * 0.45)) * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uDim;
        uniform vec3 uLit;
        varying float vShade;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * (0.35 + vShade * 0.65);
          if (a < 0.01) discard;
          gl_FragColor = vec4(mix(uDim, uLit, vShade), a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    group.add(new THREE.Points(dotGeom, dotMat));

    // --- Markers, pulses and arcs -------------------------------------------
    const markerTex = markerTexture();
    const glowTex = discTexture(BRIGHT, "rgba(126,247,228,0)");
    const pulseTex = ringTexture();
    const markerLayer = new THREE.Group();
    group.add(markerLayer);
    const arcLayer = new THREE.Group();
    group.add(arcLayer);

    interface Marker {
      id: string;
      dir: THREE.Vector3; // unit direction, for far-side fading
      sprite: THREE.Sprite;
      pulse: THREE.Sprite;
      self: boolean;
      phase: number;
      /** 0 = hidden behind the planet, 1 = fully facing the camera. */
      vis: number;
    }
    // Rises to 1 when a block lands, then decays — the atmosphere flash.
    let rimBoost = 0;
    let markers: Marker[] = [];
    let arcs: { line: THREE.Line; head: THREE.Sprite; curve: THREE.QuadraticBezierCurve3; phase: number }[] = [];
    /** The explorer's OWN node — the RPC every block and transaction on this
     *  page was actually read from. Relays are drawn leaving it. */
    let vantage: Marker | null = null;

    // Country labels live in an HTML layer over the canvas rather than as 3D
    // sprites: text stays crisp at any pixel ratio and inherits the site's type.
    // They are always visible (not hover-gated) and simply fade out with the
    // far side of the globe.
    const labelLayer = document.createElement("div");
    labelLayer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none";
    mount.appendChild(labelLayer);
    // `half` is the label's half-width, MEASURED ONCE here. Reading offsetWidth
    // inside the render loop forced a synchronous layout on every frame for
    // every label — by far the most expensive thing this component did.
    let labelEls: { el: HTMLDivElement; dir: THREE.Vector3; anchor: THREE.Vector3; half: number }[] = [];
    // Country NAMES do not fit a phone. "United States 12" is ~130px against a
    // ~360px viewport, so a handful of them span the whole globe, the declutter
    // pass shoves them into a vertical stack far from the countries they name,
    // and the result reads as a broken overlay rather than a map. A flag is the
    // same identifier in ~20px and needs no translation, so small screens get
    // flag + count and the name moves to the tap/hover detail.
    let labelsCompact = isCompactViewport();

    const buildLabels = () => {
      for (const l of labelEls) l.el.remove();
      labelEls = labelsRef.current.map((c) => {
        const el = document.createElement("div");
        el.style.cssText =
          "position:absolute;left:0;top:0;white-space:nowrap;line-height:1.1;" +
          // Slightly larger when compact: it is the only identifier left, and a
          // flag glyph at 12px is unreadable on a dense phone screen.
          (labelsCompact ? "font-size:15px;" : "font-size:12px;") +
          "color:#f6f6f8;text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.7);will-change:transform,opacity";
        el.innerHTML = labelsCompact
          ? `<span>${flagOf(c.code)}</span>` +
            `<span style="color:#17d6be;margin-left:4px;font-size:12px;font-weight:600">${c.count}</span>`
          : `<span style="opacity:.95">${flagOf(c.code)}</span> ` +
            `<span>${c.name}</span>` +
            `<span style="color:#17d6be;margin-left:6px">${c.count}</span>`;
        el.title = `${c.name} · ${c.count}`;
        labelLayer.appendChild(el);
        // Anchor a little above the surface so the text clears its markers.
        const anchor = latLonToVec3(c.lat, c.lon, 1.02);
        return { el, dir: anchor.clone().normalize(), anchor, half: (el.offsetWidth || 80) / 2 };
      });
    };

    const clearLayer = (layer: THREE.Group) => {
      for (const child of [...layer.children]) {
        layer.remove(child);
        if (child instanceof THREE.Sprite) (child.material as THREE.SpriteMaterial).dispose();
        if (child instanceof THREE.Line) child.geometry.dispose();
      }
    };

    /** Rebuild markers + arcs from the current node list. */
    const buildMarkers = () => {
      clearLayer(markerLayer);
      clearLayer(arcLayer);
      markers = [];
      arcs = [];
      vantage = null;

      const placed = nodesRef.current.filter((n) => n.lat != null && n.lon != null);
      const self = placed.find((n) => n.self);
      const vantageVec = self ? latLonToVec3(self.lat!, self.lon!, 1.005) : null;

      for (const n of placed) {
        const pos = latLonToVec3(n.lat!, n.lon!, 1.012);
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: markerTex,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            // The texture already carries the teal falloff, so tint only lightly
            // — a full BRIGHT tint would swallow the white core it bakes in.
            color: new THREE.Color(n.self ? "#ffffff" : "#dffff9"),
          }),
        );
        sprite.position.copy(pos);
        sprite.scale.setScalar(n.self ? 0.075 : 0.055);
        sprite.userData.nodeId = n.id;
        markerLayer.add(sprite);

        const pulse = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: pulseTex,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            color: new THREE.Color(TEAL),
          }),
        );
        pulse.position.copy(pos);
        markerLayer.add(pulse);

        const marker: Marker = {
          id: n.id,
          dir: pos.clone().normalize(),
          sprite,
          pulse,
          self: n.self,
          phase: Math.random() * Math.PI * 2,
          vis: 1,
        };
        markers.push(marker);
        if (n.self) vantage = marker;

        // Arc from the vantage node out to this peer, lifted by an amount that
        // grows with the angular distance so long hops bow further out.
        if (vantageVec && !n.self) {
          const end = pos.clone();
          const angle = vantageVec.angleTo(end);
          const mid = vantageVec
            .clone()
            .add(end)
            .multiplyScalar(0.5)
            .normalize()
            .multiplyScalar(1 + angle * 0.34);
          const curve = new THREE.QuadraticBezierCurve3(vantageVec.clone(), mid, end);
          const pts = curve.getPoints(28);
          const geom = new THREE.BufferGeometry().setFromPoints(pts);
          // Fade the arc toward its middle so it reads as a link between two
          // endpoints rather than a hard wire drawn over the planet.
          const cols = new Float32Array(pts.length * 3);
          const bright = new THREE.Color(BRIGHT);
          const dim = new THREE.Color(TEAL);
          for (let i = 0; i < pts.length; i++) {
            const t = i / (pts.length - 1);
            const c = dim.clone().lerp(bright, Math.abs(t - 0.5) * 2);
            cols.set([c.r, c.g, c.b], i * 3);
          }
          geom.setAttribute("color", new THREE.BufferAttribute(cols, 3));
          const line = new THREE.Line(
            geom,
            new THREE.LineBasicMaterial({
              vertexColors: true,
              transparent: true,
              opacity: 0.22,
              depthTest: true,
            }),
          );
          arcLayer.add(line);

          const head = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: glowTex,
              transparent: true,
              depthTest: true,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              color: new THREE.Color(BRIGHT),
            }),
          );
          head.scale.setScalar(0.035);
          arcLayer.add(head);
          arcs.push({ line, head, curve, phase: Math.random() });
        }
      }
    };
    buildMarkers();
    buildLabels();
    rebuildRef.current = () => {
      buildMarkers();
      buildLabels();
      orient();
    };

    // Open facing the nodes: swing the busiest meridian to the front and tilt
    // by their mean latitude, so the cluster lands in the middle of the frame
    // instead of clinging to the top edge (most nodes sit well north).
    //
    // This has to happen when the FIRST real node list arrives, not on mount —
    // the dashboard mounts the globe immediately, while `nodes` is still empty.
    let oriented = false;
    const orient = () => {
      const placed = nodesRef.current.filter((n) => n.lon != null && n.lat != null);
      if (oriented || !placed.length) return;
      oriented = true;
      const meanLon = placed.reduce((a, n) => a + (n.lon as number), 0) / placed.length;
      const meanLat = placed.reduce((a, n) => a + (n.lat as number), 0) / placed.length;
      group.rotation.y = -((meanLon + 180) * Math.PI) / 180 + Math.PI / 2;
      // Rotating +lat about X brings a point at that latitude round to the front.
      group.rotation.x = THREE.MathUtils.clamp((meanLat * Math.PI) / 180, -0.9, 0.9);
    };
    orient();

    // --- Live activity: what the network is DOING, on top of where it is -----
    //
    // A transaction ripples at one of the real node markers and floats its
    // (scrambling → resolving) id; a block flashes the atmosphere and floats a
    // pill. Both tags are real links into the explorer. This is the storytelling
    // the old shielded mesh carried, moved onto the globe so there is one model.
    const overlay = document.createElement("div");
    overlay.className = "meshtags";
    mount.appendChild(overlay);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();

    interface Ripple {
      sprite: THREE.Sprite;
      dir: THREE.Vector3;
      born: number;
    }
    const ripples: Ripple[] = [];
    const RIPPLE_LIFE = 1.8;

    /** A transaction physically leaving the vantage node along a peer arc. */
    interface Packet {
      sprite: THREE.Sprite;
      curve: THREE.QuadraticBezierCurve3;
      born: number;
    }
    const packets: Packet[] = [];
    const PACKET_LIFE = 1.4;

    /** Last block seen, so the quiet-time chatter can quote real numbers. */
    let lastBlock: GlobeBlock | null = null;
    /** Timestamp of the last tag of any kind — the clutter governor. */
    let lastTagAt = 0;

    const spawnTag = (
      cls: string,
      text: string,
      xPct: number,
      yPct: number,
      opts: { id?: string; href?: string; info?: string } = {},
    ) => {
      // Three at a time, not six: at 1 BPS the old cap kept the frame permanently
      // papered over, which is most of what made the globe feel busy.
      if (overlay.children.length > 2) return;
      lastTagAt = performance.now();
      const el = document.createElement(opts.href ? "a" : "span") as HTMLElement;
      el.className = opts.href ? `${cls} meshtag--link` : cls;
      const small = viewW < 640;
      el.style.left = `${Math.min(Math.max(xPct, 6), small ? 60 : 84)}%`;
      el.style.top = `${Math.min(Math.max(yPct, 8), small ? 74 : 86)}%`;
      el.textContent = text;
      const life = opts.href ? 5200 : 4000;
      el.style.animationDuration = `${life}ms`;
      if (opts.href) {
        (el as HTMLAnchorElement).href = opts.href;
        if (opts.info) el.dataset.info = opts.info;
        el.addEventListener("click", (e) => {
          e.preventDefault();
          if (navRef.current) navRef.current(opts.href!);
          else window.location.href = opts.href!;
        });
      }
      overlay.appendChild(el);
      if (opts.id) {
        const id = opts.id;
        const born = performance.now();
        const iv = setInterval(() => {
          const t = (performance.now() - born) / life;
          el.textContent = hashDisplay(id, t);
          if (t >= 0.42) {
            clearInterval(iv);
            intervals.delete(iv);
          }
        }, 66);
        intervals.add(iv);
      }
      // Never yank a tag out from under the cursor: retry while hovered.
      const scheduleRemove = (delay: number) => {
        const tm = setTimeout(() => {
          if (el.matches(":hover")) scheduleRemove(1500);
          else el.remove();
        }, delay);
        timers.add(tm);
      };
      scheduleRemove(life);
    };

    /** Screen position (in % of the canvas) of a point on the globe. */
    const pctOf = (v: THREE.Vector3) => {
      const p = projected.copy(v).applyMatrix4(group.matrixWorld).project(camera);
      return { x: ((p.x + 1) / 2) * 100, y: ((-p.y + 1) / 2) * 100 };
    };

    /** A shielded transfer, staged where it genuinely happened.
     *
     *  The explorer reads its feed from ONE node — the white "this explorer"
     *  marker — so that node demonstrably saw this transaction. The ripple fires
     *  there and packets run outward along the real peer arcs: a relay, not a
     *  guess about which country the sender was in (we cannot know that, and a
     *  shielded chain is the last place to pretend otherwise). The pill quotes
     *  the bundle's real Orchard action count. */
    spawnTxRef.current = (tx: GlobeTx) => {
      const origin = vantage ?? markers[0];
      if (!origin) return;

      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: pulseTex,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          color: new THREE.Color(BRIGHT),
        }),
      );
      sprite.position.copy(origin.sprite.position);
      sprite.scale.setScalar(0.04);
      group.add(sprite);
      ripples.push({ sprite, dir: origin.dir.clone(), born: clock.elapsedTime });

      // Fan it out to a few peers. Prefer arcs whose far end is currently in
      // view, so the relay is something you can actually watch happen.
      const visibleArcs = arcs.filter((a) => a.curve.v2.clone().applyQuaternion(group.quaternion).z > -0.2);
      const pool = visibleArcs.length ? visibleArcs : arcs;
      for (let i = 0; i < Math.min(3, pool.length); i++) {
        const a = pool[Math.floor(Math.random() * pool.length)];
        const p = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTex,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            color: new THREE.Color(0xffffff),
          }),
        );
        p.scale.setScalar(0.05);
        group.add(p);
        packets.push({ sprite: p, curve: a.curve, born: clock.elapsedTime - i * 0.12 });
      }

      const at = pctOf(origin.sprite.position);
      const short = tx.id.slice(0, 12);
      spawnTag("meshtag", short, at.x, at.y - 6, {
        id: short,
        href: `/transactions/${tx.id}`,
        info: `${tx.actions} orchard action${tx.actions === 1 ? "" : "s"} · halo2 proof verified · relayed`,
      });
    };

    /** A block: always flash the rim; only sometimes float a pill.
     *  The chain runs at 1 BPS, so a pill per block is one every second. */
    let lastBlockTag = 0;
    spawnBlockRef.current = (b: GlobeBlock) => {
      rimBoost = 1;
      lastBlock = b;
      const now = performance.now();
      if (now - lastBlockTag < 5000) return;
      lastBlockTag = now;
      spawnTag(
        "meshtag--block",
        `⬢ ${b.blue.toLocaleString("en-US")} · ${b.txs} tx`,
        8 + Math.random() * 60,
        12 + Math.random() * 62,
        { href: `/blocks/${b.hash}`, info: "accepted block" },
      );
    };

    // Quiet-time chatter. Only speaks when the chain has given the globe nothing
    // to say for a while, so real events are never competing with filler.
    const ambientTimer = setInterval(() => {
      if (document.hidden || !visible) return;
      if (performance.now() - lastTagAt < 7000) return;
      spawnTag(
        "meshtag--dim",
        AMBIENT[Math.floor(Math.random() * AMBIENT.length)](lastBlock),
        6 + Math.random() * 62,
        10 + Math.random() * 66,
      );
    }, 4000);
    intervals.add(ambientTimer);

    // --- Interaction ---------------------------------------------------------
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    // Spin velocity in radians per SECOND, so coasting is identical whether the
    // loop is running at 60 or 30 fps. The previous per-frame figure decayed at
    // whatever rate the loop happened to be ticking at.
    let velX = 0;
    let velY = 0;
    let lastMoveAt = 0;
    let hovering = false;
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    let hoveredId: string | null = null;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveAt = e.timeStamp;
      velX = velY = 0;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;

      // The globe tracks the pointer EXACTLY, unsmoothed: a drag is direct
      // manipulation and any easing here reads as lag.
      const turnX = (dx / Math.max(1, rect.width)) * DRAG_SPAN_X;
      const turnY = (dy / Math.max(1, rect.height)) * DRAG_SPAN_Y;
      group.rotation.y += turnX;
      group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + turnY, -1.1, 1.1);

      // Release momentum is a SMOOTHED velocity, which the old code got wrong: it
      // kept the last single frame's delta, so a flick whose final pointer event
      // happened to be short — extremely common, since a hand decelerates before
      // letting go — released with almost no momentum and the globe stopped dead.
      // Averaging the recent motion makes a flick behave like a flick every time.
      const dtMs = Math.max(1, e.timeStamp - lastMoveAt);
      lastMoveAt = e.timeStamp;
      const instX = (turnX / dtMs) * 1000;
      const instY = (turnY / dtMs) * 1000;
      velX = THREE.MathUtils.clamp(velX * 0.55 + instX * 0.45, -MAX_SPIN, MAX_SPIN);
      velY = THREE.MathUtils.clamp(velY * 0.55 + instY * 0.45, -MAX_SPIN, MAX_SPIN);
    };
    const onUp = (e: PointerEvent) => {
      // A tap that never moved is a selection, not a spin.
      if (!moved && hoveredId) selectCb.current?.(hoveredId);
      // Held still before releasing: the user was aiming, not throwing.
      if (e.timeStamp - lastMoveAt > STALE_FLICK_MS) velX = velY = 0;
      canvas.style.cursor = "grab";
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    const onEnter = () => (hovering = true);
    const onLeave = () => {
      hovering = false;
      if (hoveredId) {
        hoveredId = null;
        hoverCb.current?.(null);
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerenter", onEnter);
    canvas.addEventListener("pointerleave", onLeave);

    // --- Sizing / visibility -------------------------------------------------
    // Cached, because the render loop needs the canvas size every frame and
    // reading clientWidth there would force a layout on each one.
    let viewW = mount.clientWidth;
    let viewH = mount.clientHeight;
    const bufferSize = new THREE.Vector2();
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      viewW = w;
      viewH = h;
      renderer.setSize(w, h, false); // false: leave the 100%-CSS sizing alone
      renderer.getDrawingBufferSize(bufferSize);
      dotMat.uniforms.uScale.value = bufferSize.y * 0.5;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // Keep air around the planet: the atmosphere shell reaches r=1.16 and the
      // country labels sit outside that again, so a tight framing clips them.
      camera.position.z = w < 640 ? 4.0 : w / h > 1.9 ? 3.75 : 3.5;
      // Labels bake their content and measured width at build time, so crossing
      // the breakpoint — a phone rotating, a desktop window dragged narrow —
      // has to rebuild them or the old shape keeps its stale half-width and the
      // declutter maths goes wrong. The panel can resize without the viewport
      // crossing the breakpoint, hence the explicit media query.
      const compact = isCompactViewport();
      if (compact !== labelsCompact) {
        labelsCompact = compact;
        buildLabels();
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let visible = true;
    const io = new IntersectionObserver((es) => (visible = es[0]?.isIntersecting ?? true));
    io.observe(mount);

    // --- Loop ----------------------------------------------------------------
    const clock = new THREE.Clock();
    let raf = 0;
    const camDir = new THREE.Vector3();
    const worldDir = new THREE.Vector3();
    const projected = new THREE.Vector3();
    // Reused each frame so decluttering allocates nothing.
    const placedLabels: { l: (typeof labelEls)[number]; vis: number; x: number; y: number; y0: number; half: number }[] = [];

    // Frame governor. A globe drifting at 0.06 rad/s does not need 60 fps — it
    // needs to be smooth *while you are pushing it around*. So: full rate under
    // the pointer or while the spin still has inertia, 30 fps otherwise. That is
    // half the GPU work for a difference nobody can see at idle.
    // Someone who has asked the OS for less motion gets a globe that holds still
    // until they grab it, and ticks slowly enough to cost almost nothing.
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const IDLE_MS = calm ? 1000 / 10 : 1000 / 30;
    let lastFrame = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden) return;
      const interacting = dragging || hovering || Math.abs(velX) > SPIN_EPSILON || Math.abs(velY) > SPIN_EPSILON;
      if (!interacting && now - lastFrame < IDLE_MS) return;
      lastFrame = now;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      // Idle spin, suspended while the pointer is on the globe so labels can be read.
      if (!dragging) {
        if (Math.abs(velX) > SPIN_EPSILON || Math.abs(velY) > SPIN_EPSILON) {
          group.rotation.y += velX * dt;
          group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + velY * dt, -1.1, 1.1);
          const decay = Math.pow(SPIN_DAMPING, dt);
          velX *= decay;
          velY *= decay;
        } else if (!hovering && !calm) {
          group.rotation.y += dt * 0.06;
        }
      }

      if (!calm) stars.rotation.y += dt * 0.008;
      camera.getWorldDirection(camDir);

      // Markers: fade with the far side, breathe, and swell when active.
      const active = activeRef.current;
      for (const m of markers) {
        worldDir.copy(m.dir).applyQuaternion(group.quaternion);
        // +1 = facing the camera, -1 = directly behind the planet.
        const facing = -worldDir.dot(camDir);
        const vis = THREE.MathUtils.smoothstep(facing, -0.05, 0.35);
        m.vis = vis;
        const isActive = active === m.id || hoveredId === m.id;
        const mat = m.sprite.material as THREE.SpriteMaterial;
        mat.opacity = vis * (isActive ? 1 : 0.9);
        const base = (m.self ? 0.075 : 0.05) * (isActive ? 1.55 : 1);
        m.sprite.scale.setScalar(base + Math.sin(t * 2 + m.phase) * 0.004);

        // Radar pulse: a ring that expands and fades, restarting every ~2.6s.
        // Kept tight — twelve big additive rings is a lot of blended pixels for
        // an effect that reads just as well small.
        const cycle = ((t * 0.38 + m.phase) % 1) ** 0.8;
        const pmat = m.pulse.material as THREE.SpriteMaterial;
        m.pulse.scale.setScalar(0.05 + cycle * (m.self ? 0.26 : 0.17));
        pmat.opacity = vis * (1 - cycle) * (m.self ? 0.5 : 0.3);
      }

      // Arcs: a light runs from the vantage node out to each peer.
      for (const a of arcs) {
        const u = (t * 0.22 + a.phase) % 1;
        a.curve.getPoint(u, a.head.position);
        worldDir.copy(a.head.position).normalize().applyQuaternion(group.quaternion);
        const facing = -worldDir.dot(camDir);
        const vis = THREE.MathUtils.smoothstep(facing, -0.1, 0.3);
        // Fade in and out at the ends so the light doesn't pop.
        const ends = Math.sin(u * Math.PI);
        (a.head.material as THREE.SpriteMaterial).opacity = vis * ends * 0.9;
        (a.line.material as THREE.LineBasicMaterial).opacity = 0.1 + vis * 0.16;
      }

      // Transaction ripples: expand and fade at the node that relayed them,
      // hidden when that node has spun round the back.
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        const age = (t - r.born) / RIPPLE_LIFE;
        if (age >= 1) {
          group.remove(r.sprite);
          (r.sprite.material as THREE.SpriteMaterial).dispose();
          ripples.splice(i, 1);
          continue;
        }
        worldDir.copy(r.dir).applyQuaternion(group.quaternion);
        const vis = THREE.MathUtils.smoothstep(-worldDir.dot(camDir), -0.05, 0.35);
        r.sprite.scale.setScalar(0.04 + age * 0.42);
        (r.sprite.material as THREE.SpriteMaterial).opacity = vis * (1 - age) * 0.85;
      }

      // Relay packets: the transaction itself, travelling out of the vantage
      // node along a real peer link and dying when it arrives.
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        const age = (t - p.born) / PACKET_LIFE;
        if (age >= 1) {
          group.remove(p.sprite);
          (p.sprite.material as THREE.SpriteMaterial).dispose();
          packets.splice(i, 1);
          continue;
        }
        if (age < 0) continue; // staggered start
        p.curve.getPoint(age, p.sprite.position);
        worldDir.copy(p.sprite.position).normalize().applyQuaternion(group.quaternion);
        const vis = THREE.MathUtils.smoothstep(-worldDir.dot(camDir), -0.1, 0.3);
        // Bright on departure, dimming as it lands.
        (p.sprite.material as THREE.SpriteMaterial).opacity = vis * (1 - age * 0.7);
        p.sprite.scale.setScalar(0.055 - age * 0.02);
      }

      // The block flash decays back to the resting atmosphere.
      if (rimBoost > 0.001) {
        rimBoost = Math.max(0, rimBoost - dt * 1.6);
        (atmosphere.material as THREE.ShaderMaterial).uniforms.uBoost.value = rimBoost;
      }

      // Country labels: project to screen, declutter, and fade with the far
      // side. Done in the loop (not React) so the text tracks the spin at frame
      // rate.
      if (labelEls.length) {
        const w = viewW;
        const h = viewH;
        placedLabels.length = 0;
        for (const l of labelEls) {
          worldDir.copy(l.dir).applyQuaternion(group.quaternion);
          const facing = -worldDir.dot(camDir);
          // Fade out well BEFORE the limb. Near the rim the projection compresses
          // hard, so a few degrees of spin slide a label a long way across the
          // screen — which is what made them look like they jump to random places.
          const vis = THREE.MathUtils.smoothstep(facing, 0.22, 0.5);
          if (vis <= 0.01) {
            l.el.style.opacity = "0";
            continue;
          }
          const p = projected.copy(l.anchor).applyMatrix4(group.matrixWorld).project(camera);
          const py = ((-p.y + 1) / 2) * h - 20;
          placedLabels.push({
            l,
            vis,
            x: ((p.x + 1) / 2) * w,
            // Sit the label just above its country's markers.
            y: py,
            // Where it BELONGS, so the declutter pass below can tell how far it
            // has been pushed and give up rather than lie about a location.
            y0: py,
            half: l.half,
          });
        }

        // Nudge colliding labels apart. Countries cluster tightly in Europe, so
        // without this the names overlap into an unreadable pile. Only labels
        // that actually overlap horizontally get pushed, which keeps each one
        // near its own marker.
        placedLabels.sort((a, b) => a.y - b.y);
        for (let i = 0; i < placedLabels.length; i++) {
          const a = placedLabels[i];
          for (let j = 0; j < i; j++) {
            const b = placedLabels[j];
            const overlapX = Math.abs(a.x - b.x) < a.half + b.half + 6;
            if (overlapX && a.y - b.y < LABEL_GAP) a.y = b.y + LABEL_GAP;
          }
        }

        for (const { l, x, y, y0, half, vis } of placedLabels) {
          // A label is only worth drawing where its country actually is. Two ways
          // it stops being that, and the old code did the wrong thing for both:
          //
          //  * it did not FIT, so it was clamped to the canvas edge — pinning it
          //    to the rim, far from its marker, sliding along the edge as the
          //    globe turned;
          //  * the declutter pass shoved it arbitrarily far to escape a pile-up.
          //
          // Both produce a flag sitting somewhere it does not belong, which reads
          // as the labels jumping around at random. Hide it instead: fewer labels
          // that are all truthful beats more labels that are not.
          const fits = x - half >= 2 && x + half <= w - 2 && y >= 8 && y <= h - 8;
          if (!fits || Math.abs(y - y0) > MAX_LABEL_SHIFT) {
            l.el.style.opacity = "0";
            continue;
          }
          l.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          l.el.style.opacity = (vis * 0.92).toFixed(3);
        }
      }

      // Hover test (skipped while dragging — the pointer is steering, not picking).
      if (hovering && !dragging) {
        raycaster.setFromCamera(pointer, camera);
        // Raycasting ignores the depth buffer, so markers on the far side would
        // still be pickable through the planet — exclude them explicitly.
        const hits = raycaster.intersectObjects(
          markers.filter((m) => m.vis > 0.45).map((m) => m.sprite),
          false,
        );
        const id = (hits[0]?.object.userData.nodeId as string | undefined) ?? null;
        if (id !== hoveredId) {
          hoveredId = id;
          canvas.style.cursor = id ? "pointer" : "grab";
          if (id) {
            const rect = canvas.getBoundingClientRect();
            const p = hits[0].object.position.clone().applyMatrix4(group.matrixWorld).project(camera);
            hoverCb.current?.(id, {
              x: ((p.x + 1) / 2) * rect.width,
              y: ((-p.y + 1) / 2) * rect.height,
            });
          } else {
            hoverCb.current?.(null);
          }
        }
      }

      renderer.render(scene, camera);
    };
    tick(performance.now());

    // --- Teardown ------------------------------------------------------------
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointerleave", onLeave);
      for (const tm of timers) clearTimeout(tm);
      for (const iv of intervals) clearInterval(iv);
      timers.clear();
      intervals.clear();
      overlay.remove();
      spawnTxRef.current = null;
      spawnBlockRef.current = null;
      for (const r of ripples) {
        group.remove(r.sprite);
        (r.sprite.material as THREE.SpriteMaterial).dispose();
      }
      ripples.length = 0;
      for (const p of packets) {
        group.remove(p.sprite);
        (p.sprite.material as THREE.SpriteMaterial).dispose();
      }
      packets.length = 0;
      clearLayer(markerLayer);
      clearLayer(arcLayer);
      for (const l of labelEls) l.el.remove();
      labelEls = [];
      labelLayer.remove();
      dotGeom.dispose();
      dotMat.dispose();
      gratGeom.dispose();
      gratMat.dispose();
      starGeom.dispose();
      starMat.dispose();
      starTex.dispose();
      markerTex.dispose();
      glowTex.dispose();
      pulseTex.dispose();
      globe.geometry.dispose();
      (globe.material as THREE.Material).dispose();
      atmosphere.geometry.dispose();
      (atmosphere.material as THREE.Material).dispose();
      renderer.dispose();
      rebuildRef.current = null;
      if (canvas.parentNode === mount) mount.removeChild(canvas);
    };
    // Built once; live data flows in through refs and the effects below.
  }, []);

  // Rebuilding markers is cheap, but doing it on every poll would restart the
  // arc animations, so only do it when the set of placed nodes actually changes.
  const signature = [
    ...nodes.map((n) => `${n.id}:${n.lat ?? ""}:${n.lon ?? ""}`).sort(),
    ...labels.map((l) => `${l.code}:${l.count}`).sort(),
  ].join("|");
  useEffect(() => {
    rebuildRef.current?.();
  }, [signature]);

  // Live feed → scene. The first batch is absorbed silently: it is the backlog
  // the page loaded with, and replaying it would fire a dozen ripples at once.
  const seenTx = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!txs) return;
    if (seenTx.current === null) {
      seenTx.current = new Set(txs.map((t) => t.id));
      return;
    }
    for (const tx of txs) {
      if (seenTx.current.has(tx.id)) continue;
      seenTx.current.add(tx.id);
      spawnTxRef.current?.(tx);
    }
    // The feed is a bounded window; keep the seen-set from growing forever.
    if (seenTx.current.size > 600) seenTx.current = new Set(txs.map((t) => t.id));
  }, [txs]);

  const seenBlocks = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!blocks) return;
    if (seenBlocks.current === null) {
      seenBlocks.current = new Set(blocks.map((b) => b.hash));
      return;
    }
    for (const b of blocks) {
      if (seenBlocks.current.has(b.hash)) continue;
      seenBlocks.current.add(b.hash);
      spawnBlockRef.current?.(b);
    }
    if (seenBlocks.current.size > 600) seenBlocks.current = new Set(blocks.map((b) => b.hash));
  }, [blocks]);

  // `relative` anchors the country-label layer over the canvas.
  return <div ref={mountRef} className="network-globe-canvas" />;
}
