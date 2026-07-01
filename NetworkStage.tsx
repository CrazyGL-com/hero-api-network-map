import * as React from 'react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useHeroAnimationFrame } from '@crazygl/core';

/* ─────────────────────────────────────────────────────────────────────────
   NetworkStage — Three.js rendering layer for the API Network Map hero.

   Coordinate spaces
     world     — three world units; graph centred at origin, nodes on a
                 sphere of radius ~2.
     ndc       — normalised device coords from camera.project, range
                 [-1, +1] each axis; used to project node positions to
                 the DOM-overlay label container.
     screenPx  — overlay-canvas pixel coords (top-left origin); derived
                 from ndc via `((x+1)/2 * w, (1-y)/2 * h)`.
     u_input   — wrapper pointer (0..1, top-left origin); we remap to
                 [-1, +1] symmetric for parallax.
     aU        — per-vertex line parameter 0..1 along each segment; the
                 fragment shader uses vU to sample pulses moving along
                 the connection.
   ───────────────────────────────────────────────────────────────────────── */

interface StageProps {
	rootRef: React.RefObject<HTMLElement | null>;
	size: { width: number; height: number; dpr: number };
	input: { x: number; y: number; active: boolean };
	seed: number;
	reducedMotion: boolean;
	labels: string[];
	nodeColor: string;
	accentColor: string;
	nodeSize: number;
	nodeMetalness: number;
	nodeRoughness: number;
	showLabels: boolean;
	labelStyle: string;
	labelTextColor: string;
	labelBgColor: string;
	labelBorderColor: string;
	labelGlowColor: string;
	labelScale: number;
	labelOpacity: number;
	labelMinOpacity: number;
	labelOffsetX: number;
	labelOffsetY: number;
	connectionDensity: number;
	lineColor: string;
	lineOpacity: number;
	lineWidth: number;
	pulseColor: string;
	pulseSpeed: number;
	pulseIntensity: number;
	pulsesPerLine: number;
	autoRotate: boolean;
	driftSpeed: number;
	pointerParallax: number;
	cameraDistance: number;
	transparentBackground: boolean;
}

const MAX_NODES = 40;
const MAX_CONNECTIONS = 200;

/* Deterministic small PRNG; replaces Math.random for SSR safety + stable
   layouts across re-mounts. mulberry32 seeded from the user seed. */
function makeRng(seed: number): () => number {
	let s = (seed >>> 0) || 1;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* Fibonacci-sphere placement — gives an even spread of N points on a
   sphere with no clustering, deterministic from a seed-derived offset.
   Reference: Saff & Kuijlaars (1997); Deserno notes (linked in spec). */
function fibonacciSpherePoints(count: number, radius: number, rng: () => number): Float32Array {
	const out = new Float32Array(count * 3);
	const phi = Math.PI * (3.0 - Math.sqrt(5.0)); // golden angle ~2.39996
	// Random per-graph rotation offset so multiple instances don't all
	// have a node at the exact "top" — deterministic via the seed-rng.
	const offset = rng() * Math.PI * 2;
	for (let i = 0; i < count; i++) {
		// y goes from +1 to -1 in `count` steps; with small jitter to
		// break the regular ring read.
		const y = 1 - (i / Math.max(1, count - 1)) * 2;
		const r = Math.sqrt(Math.max(0, 1 - y * y));
		const theta = phi * i + offset;
		// Mild radial jitter so the sphere doesn't read as a perfect grid.
		const rj = radius * (0.92 + rng() * 0.16);
		out[i * 3 + 0] = Math.cos(theta) * r * rj;
		out[i * 3 + 1] = y * rj;
		out[i * 3 + 2] = Math.sin(theta) * r * rj;
	}
	return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Custom shader for the connection lines. Each segment carries:
     aU     — per-vertex 0..1 along its segment
     aPhase — per-segment phase offset (same on both verts), so pulses
              start at different points across the graph.
     aSeed  — per-segment seed used to vary the per-pulse speed slightly
              so the network doesn't feel metronomic.

   Uniforms:
     u_time           — seconds since mount
     u_lineColor      — base line tint
     u_lineOpacity    — base line alpha (additive scale)
     u_pulseColor     — pulse tint
     u_pulseSpeed     — pulses/sec along the line
     u_pulseIntensity — brightness multiplier
     u_pulseCount     — int, 1..4

   The pulse term is a Gaussian rolling along the parameter `vU`. We
   fract() the position so the pulse wraps from u=1 back to u=0 — a real
   wavefront, not concentric rings (catalog reminder).
   ───────────────────────────────────────────────────────────────────────── */

const LINE_VERT = /* glsl */ `
	attribute float aU;
	attribute float aPhase;
	attribute float aSeed;
	varying float vU;
	varying float vPhase;
	varying float vSeed;
	void main() {
		vU = aU;
		vPhase = aPhase;
		vSeed = aSeed;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

const LINE_FRAG = /* glsl */ `
	precision highp float;

	uniform float u_time;
	uniform vec3  u_lineColor;
	uniform float u_lineOpacity;
	uniform vec3  u_pulseColor;
	uniform float u_pulseSpeed;
	uniform float u_pulseIntensity;
	uniform int   u_pulseCount;

	varying float vU;
	varying float vPhase;
	varying float vSeed;

	// Gaussian falloff with a soft width.
	float gauss(float x, float w) {
		// Wrap x into [-0.5, +0.5] for the toroidal distance along u.
		float d = x - floor(x + 0.5);
		return exp(-(d * d) / (w * w));
	}

	void main() {
		// Base line — emissive, plus a soft endpoint dimming so segments
		// look "rooted" into the nodes rather than abruptly clipped.
		float endpointDim = smoothstep(0.0, 0.08, vU) * smoothstep(1.0, 0.92, vU);
		vec3 baseCol = u_lineColor * u_lineOpacity * mix(0.65, 1.0, endpointDim);

		// Pulses. Each pulse marches at u_pulseSpeed along u, offset by
		// aPhase + i / N. We treat u as a periodic coordinate (wraps at 1).
		// vSeed perturbs the per-line speed by up to plus/minus 10 percent
		// so the field does not tick in lock-step.
		float speed = u_pulseSpeed * (0.9 + vSeed * 0.2);
		float pulseN = max(1.0, float(u_pulseCount));
		float pulseSum = 0.0;
		// Width = full-width-at-half-max ~0.05 — narrow, comet-like.
		float w = 0.05;
		// Unrolled fixed cap of 4 — matches the slider max.
		for (int i = 0; i < 4; i++) {
			if (i >= u_pulseCount) break;
			float offsetI = float(i) / pulseN;
			float pos = fract(u_time * speed + vPhase + offsetI);
			pulseSum += gauss(vU - pos, w);
		}
		// Comet tail: an asymmetric trail behind each pulse. Add a soft
		// directional smear by sampling a phase-shifted, wider gaussian.
		float trailSum = 0.0;
		for (int i = 0; i < 4; i++) {
			if (i >= u_pulseCount) break;
			float offsetI = float(i) / pulseN;
			float pos = fract(u_time * speed + vPhase + offsetI);
			float d = vU - pos;
			// Wrap to [-0.5, +0.5] (same toroidal trick as gauss()).
			d = d - floor(d + 0.5);
			// Only the trailing side (d < 0, i.e. behind the pulse along u).
			if (d < 0.0) {
				trailSum += exp(-(d * d) / (0.18 * 0.18)) * 0.35;
			}
		}

		vec3 pulseCol = u_pulseColor * (pulseSum + trailSum) * u_pulseIntensity;
		vec3 col = baseCol + pulseCol;

		// Additive blending (SRC_ALPHA, ONE). We want col to be added to
		// the framebuffer at full strength regardless of luminance — so
		// alpha is 1.0. This avoids dim pulses being multiplicatively
		// darkened by their own alpha. col itself already encodes
		// brightness via the per-fragment Gaussian.
		gl_FragColor = vec4(col, 1.0);
	}
`;

export default function NetworkStage(props: StageProps) {
	const {
		rootRef,
		size,
		input,
		seed,
		reducedMotion,
		labels,
		nodeColor,
		accentColor,
		nodeSize,
		nodeMetalness,
		nodeRoughness,
	showLabels,
	labelStyle,
	labelTextColor,
	labelBgColor,
	labelBorderColor,
	labelGlowColor,
	labelScale,
	labelOpacity,
	labelMinOpacity,
	labelOffsetX,
	labelOffsetY,
	connectionDensity,
	lineColor,
	lineOpacity,
	lineWidth,
	pulseColor,
		pulseSpeed,
		pulseIntensity,
		pulsesPerLine,
		autoRotate,
		driftSpeed,
		pointerParallax,
		cameraDistance,
		transparentBackground,
	} = props;

	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
	const labelLayerRef = React.useRef<HTMLDivElement | null>(null);
	const rendererRef = React.useRef<THREE.WebGLRenderer | null>(null);
	const sceneRef = React.useRef<THREE.Scene | null>(null);
	const cameraRef = React.useRef<THREE.PerspectiveCamera | null>(null);
	const cameraRigRef = React.useRef<THREE.Group | null>(null);

	const nodeInstRef = React.useRef<THREE.InstancedMesh | null>(null);
	const nodeGeoRef = React.useRef<THREE.SphereGeometry | null>(null);
	const nodeMatRef = React.useRef<THREE.MeshStandardMaterial | null>(null);
	const nodePositionsRef = React.useRef<Float32Array | null>(null);
	const nodeColorTintRef = React.useRef<Uint8Array | null>(null); // 0/1 per node: use accent?

	const linesRef = React.useRef<THREE.LineSegments | null>(null);
	const lineGeoRef = React.useRef<THREE.BufferGeometry | null>(null);
	const lineMatRef = React.useRef<THREE.ShaderMaterial | null>(null);
	const baseLinesRef = React.useRef<LineSegments2 | null>(null);
	const baseLineGeoRef = React.useRef<LineSegmentsGeometry | null>(null);
	const baseLineMatRef = React.useRef<LineMaterial | null>(null);

	// Time + camera state — refs, no rerenders.
	const elapsedRef = React.useRef(0);
	const camYawRef = React.useRef(0);
	const camPitchRef = React.useRef(0);
	const camYawTargetRef = React.useRef(0);
	const camPitchTargetRef = React.useRef(0);

	// Label layer state for projection. We hold refs to <span> children
	// so we can update transform without React re-renders.
	const labelRefsRef = React.useRef<Array<HTMLSpanElement | null>>([]);

	// Resolved node count (clamped to labels.length, MAX_NODES).
	const nodeCount = Math.min(Math.max(labels.length, 0), MAX_NODES);

	/* ─────────────────────────────────────────────────────────────────
	   One-time scene + GL setup. Creates renderer, scene, camera, lights,
	   the InstancedMesh of nodes, and the LineSegments mesh with the
	   custom shader material. All buffers sized to MAX caps; we use
	   draw range / instance count to reveal exactly as many as needed.
	   ───────────────────────────────────────────────────────────────── */
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			premultipliedAlpha: false,
			powerPreference: 'high-performance',
		});
		renderer.setPixelRatio(Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 1.75));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.NoToneMapping;
		renderer.setClearColor(0x000000, 0);
		rendererRef.current = renderer;

		const scene = new THREE.Scene();
		scene.background = null;
		sceneRef.current = scene;

		const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
		camera.position.set(0, 0, cameraDistance);
		camera.lookAt(0, 0, 0);
		cameraRef.current = camera;
		// Camera rig: parent group that we yaw / pitch each frame so the
		// scene appears to orbit. Camera local pos stays at +Z; the rig's
		// rotation does the orbit. Pointer parallax is applied as a
		// secondary additive offset on top of the auto-yaw / auto-pitch.
		const rig = new THREE.Group();
		rig.add(camera);
		scene.add(rig);
		cameraRigRef.current = rig;

		// Lights — three-point: key from above-left, fill from below-right,
		// rim from behind. Keeps the metal nodes reading as 3D from any
		// orbit angle.
		const key = new THREE.DirectionalLight(0xffffff, 0.95);
		key.position.set(-3, 4, 5);
		scene.add(key);
		const fill = new THREE.DirectionalLight(0x88a0ff, 0.45);
		fill.position.set(3, -2, 2);
		scene.add(fill);
		const rim = new THREE.DirectionalLight(0xa0d0ff, 0.6);
		rim.position.set(0, 1, -5);
		scene.add(rim);
		const ambient = new THREE.AmbientLight(0x202840, 0.7);
		scene.add(ambient);

		// Node geometry + material. A true sphere keeps the nodes reading as
		// polished network beads rather than low-poly chips, while the
		// instanced draw keeps the cost flat even at the MAX_NODES cap.
		const nodeGeo = new THREE.SphereGeometry(1, 48, 32);
		nodeGeoRef.current = nodeGeo;
		const nodeMat = new THREE.MeshStandardMaterial({
			color: 0xffffff,
			metalness: nodeMetalness,
			roughness: nodeRoughness,
			emissive: 0x000000,
			emissiveIntensity: 0,
		});
		nodeMatRef.current = nodeMat;
		const inst = new THREE.InstancedMesh(nodeGeo, nodeMat, MAX_NODES);
		// Per-instance color so a subset of nodes use the accent tint.
		const instColors = new Float32Array(MAX_NODES * 3);
		inst.instanceColor = new THREE.InstancedBufferAttribute(instColors, 3);
		inst.frustumCulled = false;
		inst.count = 0;
		scene.add(inst);
		nodeInstRef.current = inst;

		// Line geometry. Pre-allocate buffers for MAX_CONNECTIONS segments.
		// Each segment is 2 vertices: position (3), aU (1), aPhase (1), aSeed (1).
		const linePositions = new Float32Array(MAX_CONNECTIONS * 2 * 3);
		const lineU = new Float32Array(MAX_CONNECTIONS * 2);
		const linePhase = new Float32Array(MAX_CONNECTIONS * 2);
		const lineSeedArr = new Float32Array(MAX_CONNECTIONS * 2);
		const lineGeo = new THREE.BufferGeometry();
		lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
		lineGeo.setAttribute('aU', new THREE.BufferAttribute(lineU, 1));
		lineGeo.setAttribute('aPhase', new THREE.BufferAttribute(linePhase, 1));
		lineGeo.setAttribute('aSeed', new THREE.BufferAttribute(lineSeedArr, 1));
		lineGeo.setDrawRange(0, 0);
		lineGeoRef.current = lineGeo;

		// Pre-fill aU as [0, 1, 0, 1, ...] — this never changes regardless
		// of which segments are active; the only mutated arrays per
		// connection-density tick are position / phase / seed.
		for (let i = 0; i < MAX_CONNECTIONS; i++) {
			lineU[i * 2 + 0] = 0;
			lineU[i * 2 + 1] = 1;
		}
		(lineGeo.attributes.aU as THREE.BufferAttribute).needsUpdate = true;

		const lineMat = new THREE.ShaderMaterial({
			uniforms: {
				u_time: { value: 0 },
				u_lineColor: { value: new THREE.Color(lineColor) },
				u_lineOpacity: { value: lineOpacity },
				u_pulseColor: { value: new THREE.Color(pulseColor) },
				u_pulseSpeed: { value: pulseSpeed },
				u_pulseIntensity: { value: pulseIntensity },
				u_pulseCount: { value: Math.max(1, Math.min(4, Math.round(pulsesPerLine))) },
			},
			vertexShader: LINE_VERT,
			fragmentShader: LINE_FRAG,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		lineMatRef.current = lineMat;
		const lines = new THREE.LineSegments(lineGeo, lineMat);
		lines.frustumCulled = false;
		lines.renderOrder = 2;
		scene.add(lines);
		linesRef.current = lines;

		// Thick base connections. Native WebGL lineWidth is not portable, so
		// LineSegments2 expands each segment in screen space and gives the
		// customizer a real pixel-width control. The existing shader line
		// remains on top for moving pulses.
		const baseLineGeo = new LineSegmentsGeometry();
		baseLineGeo.setPositions(new Float32Array(0));
		const baseLineMat = new LineMaterial({
			color: new THREE.Color(lineColor).getHex(),
			linewidth: Math.max(0.4, lineWidth),
			transparent: true,
			opacity: Math.max(0, Math.min(1, lineOpacity * 0.8)),
			depthWrite: false,
			depthTest: true,
			blending: THREE.AdditiveBlending,
			resolution: new THREE.Vector2(Math.max(1, size.width), Math.max(1, size.height)),
		});
		const baseLines = new LineSegments2(baseLineGeo, baseLineMat);
		baseLines.frustumCulled = false;
		baseLines.renderOrder = 1;
		scene.add(baseLines);
		baseLinesRef.current = baseLines;
		baseLineGeoRef.current = baseLineGeo;
		baseLineMatRef.current = baseLineMat;

		return () => {
			renderer.dispose();
			nodeGeo.dispose();
			nodeMat.dispose();
			lineGeo.dispose();
			lineMat.dispose();
			baseLineGeo.dispose();
			baseLineMat.dispose();
			rendererRef.current = null;
			sceneRef.current = null;
			cameraRef.current = null;
			cameraRigRef.current = null;
			nodeInstRef.current = null;
			nodeGeoRef.current = null;
			nodeMatRef.current = null;
			linesRef.current = null;
			lineGeoRef.current = null;
			lineMatRef.current = null;
			baseLinesRef.current = null;
			baseLineGeoRef.current = null;
			baseLineMatRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/* ─────────────────────────────────────────────────────────────────
	   Resize. Renderer + camera aspect.
	   ───────────────────────────────────────────────────────────────── */
	React.useEffect(() => {
		const renderer = rendererRef.current;
		const camera = cameraRef.current;
		if (!renderer || !camera) return;
		const w = Math.max(1, Math.floor(size.width));
		const h = Math.max(1, Math.floor(size.height));
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		const baseLineMat = baseLineMatRef.current;
		if (baseLineMat) baseLineMat.resolution.set(w, h);
	}, [size.width, size.height]);

	/* Camera distance live update. */
	React.useEffect(() => {
		const camera = cameraRef.current;
		if (!camera) return;
		camera.position.set(0, 0, cameraDistance);
	}, [cameraDistance]);

	/* Node material live updates — no geometry rebuild. */
	React.useEffect(() => {
		const m = nodeMatRef.current;
		if (!m) return;
		m.metalness = nodeMetalness;
		m.roughness = nodeRoughness;
	}, [nodeMetalness, nodeRoughness]);

	/* Line material live updates. */
	React.useEffect(() => {
		const m = lineMatRef.current;
		const base = baseLineMatRef.current;
		if (!m) return;
		(m.uniforms.u_lineColor.value as THREE.Color).set(lineColor);
		if (base) base.color.set(lineColor);
	}, [lineColor]);
	React.useEffect(() => {
		const m = lineMatRef.current;
		if (m) m.uniforms.u_lineOpacity.value = lineOpacity;
		const base = baseLineMatRef.current;
		if (base) base.opacity = Math.max(0, Math.min(1, lineOpacity * 0.8));
	}, [lineOpacity]);
	React.useEffect(() => {
		const base = baseLineMatRef.current;
		if (!base) return;
		base.linewidth = Math.max(0.4, lineWidth);
	}, [lineWidth]);
	React.useEffect(() => {
		const m = lineMatRef.current;
		if (!m) return;
		(m.uniforms.u_pulseColor.value as THREE.Color).set(pulseColor);
	}, [pulseColor]);
	React.useEffect(() => {
		const m = lineMatRef.current;
		if (!m) return;
		m.uniforms.u_pulseSpeed.value = pulseSpeed;
	}, [pulseSpeed]);
	React.useEffect(() => {
		const m = lineMatRef.current;
		if (!m) return;
		m.uniforms.u_pulseIntensity.value = pulseIntensity;
	}, [pulseIntensity]);
	React.useEffect(() => {
		const m = lineMatRef.current;
		if (!m) return;
		m.uniforms.u_pulseCount.value = Math.max(1, Math.min(4, Math.round(pulsesPerLine)));
	}, [pulsesPerLine]);

	/* ─────────────────────────────────────────────────────────────────
	   Node layout. Recompute when the node count, size, or color choices
	   change. Position the InstancedMesh transforms via setMatrixAt.
	   ───────────────────────────────────────────────────────────────── */
	React.useEffect(() => {
		const inst = nodeInstRef.current;
		if (!inst) return;
		const rng = makeRng(((seed || 1) * 2654435761) >>> 0);
		const radius = 2.0;
		// Place nodes on a fibonacci sphere. We pre-compute positions and
		// stash them in a ref so the per-frame label projection + the line
		// rebuild can reuse them without re-running the layout.
		const positions = fibonacciSpherePoints(nodeCount, radius, rng);
		nodePositionsRef.current = positions;

		// Per-node "use accent?" flag — ~25% of nodes use accentColor.
		const tints = new Uint8Array(MAX_NODES);
		for (let i = 0; i < nodeCount; i++) {
			tints[i] = rng() < 0.25 ? 1 : 0;
		}
		nodeColorTintRef.current = tints;

		const tmpMat = new THREE.Matrix4();
		const tmpPos = new THREE.Vector3();
		const tmpQuat = new THREE.Quaternion();
		const tmpScale = new THREE.Vector3(nodeSize, nodeSize, nodeSize);

		const baseCol = new THREE.Color(nodeColor);
		const accCol = new THREE.Color(accentColor);
		const tmpCol = new THREE.Color();

		for (let i = 0; i < nodeCount; i++) {
			tmpPos.set(positions[i * 3 + 0], positions[i * 3 + 1], positions[i * 3 + 2]);
			// Random per-node rotation so the icosahedron facets catch
			// light differently across the cluster.
			const ax = rng() * Math.PI * 2;
			const ay = rng() * Math.PI * 2;
			const az = rng() * Math.PI * 2;
			tmpQuat.setFromEuler(new THREE.Euler(ax, ay, az));
			tmpMat.compose(tmpPos, tmpQuat, tmpScale);
			inst.setMatrixAt(i, tmpMat);
			tmpCol.copy(tints[i] ? accCol : baseCol);
			inst.setColorAt(i, tmpCol);
		}
		inst.count = nodeCount;
		inst.instanceMatrix.needsUpdate = true;
		if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
	}, [nodeCount, nodeSize, seed, nodeColor, accentColor]);

	/* ─────────────────────────────────────────────────────────────────
	   Connection topology. Build the line buffer when the node layout
	   or density changes. Strategy: enumerate all node pairs, sort by
	   distance, take the top K shortest where K = round(density *
	   maxPairs). Cap at MAX_CONNECTIONS.
	   ───────────────────────────────────────────────────────────────── */
	React.useEffect(() => {
		const positions = nodePositionsRef.current;
		const lineGeo = lineGeoRef.current;
		const baseLineGeo = baseLineGeoRef.current;
		if (!positions || !lineGeo) return;

		const pairs: Array<{ a: number; b: number; d: number }> = [];
		for (let i = 0; i < nodeCount; i++) {
			for (let j = i + 1; j < nodeCount; j++) {
				const dx = positions[i * 3 + 0] - positions[j * 3 + 0];
				const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
				const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
				pairs.push({ a: i, b: j, d: dx * dx + dy * dy + dz * dz });
			}
		}
		pairs.sort((p, q) => p.d - q.d);
		const maxPairs = pairs.length;
		const wanted = Math.max(0, Math.min(MAX_CONNECTIONS, Math.round(connectionDensity * maxPairs)));
		// Ensure connectivity at low densities: take at least nodeCount-1
		// edges so the graph isn't a scatter of unconnected points (only
		// if density > 0 — at density 0 the user explicitly wants nothing).
		const minEdges = connectionDensity > 0 ? Math.min(maxPairs, Math.max(0, nodeCount - 1)) : 0;
		const count = Math.max(wanted, minEdges);

		const posAttr = lineGeo.attributes.position as THREE.BufferAttribute;
		const phaseAttr = lineGeo.attributes.aPhase as THREE.BufferAttribute;
		const seedAttr = lineGeo.attributes.aSeed as THREE.BufferAttribute;
		const posArr = posAttr.array as Float32Array;
		const phaseArr = phaseAttr.array as Float32Array;
		const seedArr = seedAttr.array as Float32Array;

		// Stable per-graph rng for phase / seed values so changing density
		// doesn't completely re-randomise the pulse pattern of edges that
		// were already there.
		const rng = makeRng(((seed || 1) * 1597334677 + 0x9e3779b9) >>> 0);

		for (let k = 0; k < count; k++) {
			const { a, b } = pairs[k];
			posArr[k * 6 + 0] = positions[a * 3 + 0];
			posArr[k * 6 + 1] = positions[a * 3 + 1];
			posArr[k * 6 + 2] = positions[a * 3 + 2];
			posArr[k * 6 + 3] = positions[b * 3 + 0];
			posArr[k * 6 + 4] = positions[b * 3 + 1];
			posArr[k * 6 + 5] = positions[b * 3 + 2];
			const phase = rng();
			const sd = rng();
			phaseArr[k * 2 + 0] = phase;
			phaseArr[k * 2 + 1] = phase;
			seedArr[k * 2 + 0] = sd;
			seedArr[k * 2 + 1] = sd;
		}
		// Zero out the unused tail (cheap, prevents stray segments leaking
		// in if drawRange was previously larger).
		for (let k = count; k < MAX_CONNECTIONS; k++) {
			posArr[k * 6 + 0] = 0; posArr[k * 6 + 1] = 0; posArr[k * 6 + 2] = 0;
			posArr[k * 6 + 3] = 0; posArr[k * 6 + 4] = 0; posArr[k * 6 + 5] = 0;
		}
		posAttr.needsUpdate = true;
		phaseAttr.needsUpdate = true;
		seedAttr.needsUpdate = true;
		lineGeo.setDrawRange(0, count * 2);
		if (baseLineGeo) {
			baseLineGeo.setPositions(posArr.slice(0, count * 6));
			baseLineGeo.computeBoundingSphere();
		}
	}, [nodeCount, connectionDensity, seed]);

	/* ─────────────────────────────────────────────────────────────────
	   Animation frame.
	   ───────────────────────────────────────────────────────────────── */
	const tmpProjVecRef = React.useRef(new THREE.Vector3());

	useHeroAnimationFrame(rootRef, ({ delta }) => {
		const renderer = rendererRef.current;
		const scene = sceneRef.current;
		const camera = cameraRef.current;
		const rig = cameraRigRef.current;
		const lineMat = lineMatRef.current;
		const positions = nodePositionsRef.current;
		if (!renderer || !scene || !camera || !rig || !lineMat) return;

		const dt = reducedMotion ? 0 : Math.min(delta, 0.066);
		elapsedRef.current += dt;
		lineMat.uniforms.u_time.value = elapsedRef.current;

		// Auto-rotate yaw. We let pulse motion go to zero under reduced
		// motion (via dt=0), and similarly freeze camera orbit.
		if (autoRotate && !reducedMotion) {
			camYawRef.current += driftSpeed * dt;
		}

		// Pointer parallax targets — input.x / input.y in 0..1. Convert
		// to symmetric -1..+1 and scale to a gentle yaw/pitch range so it
		// adds to the autorotate base without being twitchy.
		const px = input ? input.x * 2 - 1 : 0;
		const py = input ? input.y * 2 - 1 : 0;
		// Yaw range ±15°, pitch ±10°. Tilt pitch with -y so moving the
		// cursor up pulls the top of the graph toward the viewer (natural
		// "look up" reading).
		camYawTargetRef.current = px * 0.26 * pointerParallax;
		camPitchTargetRef.current = -py * 0.17 * pointerParallax;

		// Smooth the parallax contribution toward the target; the orbit
		// yaw accumulates linearly in camYawRef and is added on top. This
		// keeps the orbit perfectly steady regardless of pointer jitter.
		// k computed for frame-rate-independent exponential smoothing.
		const k = 1 - Math.pow(0.001, Math.max(1e-3, dt));
		// camYawRef = orbit accumulator (linear); camPitchRef + a
		// scratch yaw-parallax field on userData = smoothed parallax.
		const ud = rig.userData as { yawSmooth?: number };
		if (typeof ud.yawSmooth !== 'number') ud.yawSmooth = 0;
		ud.yawSmooth += (camYawTargetRef.current - ud.yawSmooth) * k;
		camPitchRef.current += (camPitchTargetRef.current - camPitchRef.current) * k;
		rig.rotation.y = camYawRef.current + ud.yawSmooth;
		rig.rotation.x = camPitchRef.current;

		renderer.render(scene, camera);

		// ── Project node positions to screen and update label transforms.
		// `camera` is a child of `rig`; render(...) above already updated
		// matrixWorldInverse so `Vector3.project(camera)` does the correct
		// world → NDC conversion that respects the rig's rotation.
		const labelLayer = labelLayerRef.current;
		const labelRefs = labelRefsRef.current;
		if (showLabels && labelLayer && positions && nodeCount > 0) {
			const w = renderer.domElement.clientWidth;
			const h = renderer.domElement.clientHeight;
			const tmpProj = tmpProjVecRef.current;
			for (let i = 0; i < nodeCount; i++) {
				const el = labelRefs[i];
				if (!el) continue;
				tmpProj.set(positions[i * 3 + 0], positions[i * 3 + 1], positions[i * 3 + 2]);
				tmpProj.project(camera);
				const sx = (tmpProj.x + 1) * 0.5 * w;
				const sy = (1 - (tmpProj.y + 1) * 0.5) * h;
				// project() returns NDC; |z| > 1 means outside the clip
				// volume (behind near or beyond far). Treat that as hidden.
				const visible = tmpProj.z >= -1 && tmpProj.z <= 1;
				// Depth-based opacity: nodes deeper in scene fade so the
				// back of the graph doesn't fight the front for legibility.
				const depth01 = (tmpProj.z + 1) * 0.5; // 0=near, 1=far
				const minAlpha = Math.max(0, Math.min(1, labelMinOpacity));
				const maxAlpha = Math.max(0, Math.min(1, labelOpacity));
				const alpha = visible ? Math.max(minAlpha, 1 - depth01 * 0.82) * maxAlpha : 0;
				el.style.transform = `translate3d(${sx + labelOffsetX}px, ${sy + labelOffsetY}px, 0) scale(${Math.max(0.6, labelScale)})`;
				el.style.opacity = String(alpha);
			}
		}
	});

	// Pre-allocate the labelRefs array length matches MAX_NODES.
	if (labelRefsRef.current.length !== MAX_NODES) {
		labelRefsRef.current = new Array(MAX_NODES).fill(null);
	}

	return (
		<>
			<canvas ref={canvasRef} className="crazygl-anm-canvas" aria-hidden="true" />
			{showLabels ? (
				<div
					ref={labelLayerRef}
					className="crazygl-anm-labels"
					data-label-style={labelStyle || 'glass'}
					style={{
						['--anm-label-text' as any]: labelTextColor,
						['--anm-label-bg' as any]: labelBgColor,
						['--anm-label-border' as any]: labelBorderColor,
						['--anm-label-glow' as any]: labelGlowColor,
					} as React.CSSProperties}
					aria-hidden="true"
				>
					{labels.slice(0, nodeCount).map((label, i) => (
						<span
							key={`${label}-${i}`}
							ref={(el) => {
								labelRefsRef.current[i] = el;
							}}
							className="crazygl-anm-label"
							style={{ transform: 'translate3d(-1000px, -1000px, 0)' }}
						>
							{label}
						</span>
					))}
				</div>
			) : null}
		</>
	);
}
