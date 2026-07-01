import * as React from 'react';
import CrazyGLWrapper, {
	useContent,
	useHeroReady,
	type HeroComponentProps,
} from '@crazygl/core';
import metadata from './metadata.json';
import './style.css';

/* ─────────────────────────────────────────────────────────────────────────
   API Network Map

   A 3D animated graph of API services connected by glowing lines. Nodes
   are small icospheres (auth, payments, db, queue, edge, …) labelled with
   DOM overlays projected from the world position each frame. Pulses of
   light travel along every connection — sampled per-fragment from a
   custom shader on a `LineSegments` material — so the graph reads as
   live traffic flowing through the network.

   Composition
     - Layer 1 (Three.js canvas): nodes + connection lines + pulse shader,
       slow camera drift, pointer parallax. Allocation-free per frame.
     - Layer 2 (DOM overlay): per-node service labels positioned by
       projecting world position to screen each frame. Sharper than
       sprite-rendered text and respects the page's fontFamily.
     - Layer 3 (DOM content): heading, subheading, CTA button.

   Physics statement
     - Nodes are placed deterministically (seed → Fibonacci-spiral on a
       sphere with mild radial jitter) so the graph layout is stable
       across re-mounts and slider changes.
     - Connections are picked as the top-K shortest pairs (by 3D distance)
       up to `connectionDensity * maxPairs`, ensuring legible topology
       rather than a hairball. This is a k-NN-style proximity graph.
     - Each line is a single segment with a shader that draws:
           glow_base = baseColor * lineOpacity
           pulse_i   = exp(-((u - phase_i) / width)^2) * pulseColor *
                        pulseIntensity
       summed over `pulsesPerLine` Gaussians whose phases march at
       `pulseSpeed * time + i / pulsesPerLine` (and wrap in 0..1 via
       fract). Single-wavefront Gaussian, not concentric sin trains —
       same lesson as the water-ripple catalog entry.
     - Camera orbits at `driftSpeed` rad/s when `autoRotate` is on, with
       pointer parallax adding a ±15° yaw / ±10° pitch on top. Reduced
       motion freezes both ambient rotation and pulse motion.

   References
     - Three.js LineSegments + a custom ShaderMaterial for per-fragment
       parameterised effects (gradient-along-line is a classic pattern).
     - Fibonacci-sphere node placement: https://www.cmu.edu/biolphys/deserno/pdf/sphere_equi.pdf
     - The skill catalog's "single-wavefront Gaussian rings, not sin
       trains" rule applies here too — each pulse is a Gaussian moving
       along the line, not a sin product.
   ───────────────────────────────────────────────────────────────────────── */

import NetworkStage from './NetworkStage';

function ApiNetworkMapHero(props: HeroComponentProps) {
	const {
		size,
		input,
		seed,
		reducedMotion,
		rootRef,
		// CTA
		ctaLabel = 'View the map →',
		ctaTextColor = '#03060e',
		ctaBgColor = '#dfeaff',
		ctaGlowColor = '#5d8bff',
		onCTAClick = '',
		// Nodes
		nodeLabels = 'auth\npayments\ndb\nqueue\nedge\ngateway\ncache\nstorage\nsearch\nworkers\nwebhooks\nanalytics',
		nodeColor = '#bfd6ff',
		accentColor = '#7aa9ff',
		nodeSize = 0.18,
		nodeMetalness = 0.55,
		nodeRoughness = 0.28,
		showLabels = true,
		labelStyle = 'glass',
		labelTextColor = '#f4f8ff',
		labelBgColor = '#071020',
		labelBorderColor = '#9cc2ff',
		labelGlowColor = '#5d8bff',
		labelScale = 1.12,
		labelOpacity = 1,
		labelMinOpacity = 0.62,
		labelOffsetX = 12,
		labelOffsetY = 10,
		// Connections
		connectionDensity = 0.45,
		lineColor = '#5d8bff',
		lineOpacity = 0.45,
		lineWidth = 2.2,
		pulseColor = '#aee0ff',
		pulseSpeed = 0.45,
		pulseIntensity = 1.2,
		pulsesPerLine = 2,
		// Camera
		autoRotate = true,
		driftSpeed = 0.06,
		pointerParallax = 0.35,
		cameraDistance = 6.0,
		// Atmosphere
		bgTop = '#0a1228',
		bgBottom = '#03060e',
		transparentBackground = false,
	} = props as any;

	const content = useContent(props);
	useHeroReady(props);

	const handleCTAClick = (e: React.MouseEvent) => {
		if (typeof onCTAClick === 'function') {
			e.preventDefault();
			(onCTAClick as (ev: React.MouseEvent) => void)(e);
			return;
		}
		if (typeof onCTAClick === 'string' && onCTAClick.length > 0) {
			e.preventDefault();
			if (typeof window !== 'undefined') window.location.href = onCTAClick;
			return;
		}
		// undefined / empty: no-op.
	};

	// Parse labels: textarea (string) or array. Provides a stable list for
	// both the stage (positions / count) and the DOM overlay (label text).
	const labels = React.useMemo<string[]>(() => {
		if (Array.isArray(nodeLabels)) {
			return (nodeLabels as unknown[])
				.map((s) => (typeof s === 'string' ? s.trim() : String(s).trim()))
				.filter(Boolean);
		}
		if (typeof nodeLabels === 'string') {
			return nodeLabels
				.split('\n')
				.map((s: string) => s.trim())
				.filter(Boolean);
		}
		return [];
	}, [nodeLabels]);

	const showCta = ctaLabel && (props as any).contentType !== 'custom';

	// NetworkStage is direct-imported (no React.lazy / Suspense). The stage
	// renders an empty <canvas> on the server and the first client render,
	// so SSR/CSR markup matches and there's no hydration mismatch. All
	// Three.js initialisation happens inside the stage's useEffect, which
	// only runs on the client. This is the same SSR-safe pattern used by
	// the other Three.js heroes (e.g. hero-cloud-flythrough).
	return (
		<>
			<crazygl-stage
				style={
					{
						position: 'absolute',
						inset: 0,
						zIndex: 0,
						overflow: 'hidden',
						background: transparentBackground
							? 'transparent'
							: `radial-gradient(ellipse at center, ${bgTop} 0%, ${bgBottom} 78%)`,
					} as React.CSSProperties
				}
			>
				<NetworkStage
					rootRef={rootRef}
					size={size}
					input={input}
					seed={seed}
					reducedMotion={reducedMotion}
					labels={labels}
					nodeColor={nodeColor}
					accentColor={accentColor}
					nodeSize={nodeSize}
					nodeMetalness={nodeMetalness}
					nodeRoughness={nodeRoughness}
					showLabels={showLabels}
					labelStyle={labelStyle}
					labelTextColor={labelTextColor}
					labelBgColor={labelBgColor}
					labelBorderColor={labelBorderColor}
					labelGlowColor={labelGlowColor}
					labelScale={labelScale}
					labelOpacity={labelOpacity}
					labelMinOpacity={labelMinOpacity}
					labelOffsetX={labelOffsetX}
					labelOffsetY={labelOffsetY}
					connectionDensity={connectionDensity}
					lineColor={lineColor}
					lineOpacity={lineOpacity}
					lineWidth={lineWidth}
					pulseColor={pulseColor}
					pulseSpeed={pulseSpeed}
					pulseIntensity={pulseIntensity}
					pulsesPerLine={pulsesPerLine}
					autoRotate={autoRotate}
					driftSpeed={driftSpeed}
					pointerParallax={pointerParallax}
					cameraDistance={cameraDistance}
					transparentBackground={transparentBackground}
				/>
			</crazygl-stage>
			<crazygl-content
				style={
					{
						position: 'absolute',
						inset: 0,
						zIndex: 1,
						display: 'flex',
						alignItems: 'center',
						pointerEvents: 'none',
					} as React.CSSProperties
				}
			>
				<div className="crazygl-anm-content">
					{content.node}
					{showCta ? (
						<div className="crazygl-anm-cta-row">
							<button
								type="button"
								onClick={handleCTAClick}
								className="crazygl-anm-cta"
								style={
									{
										color: ctaTextColor,
										background: ctaBgColor,
										boxShadow: `0 0 0 1px rgba(255,255,255,0.08), 0 6px 28px ${ctaGlowColor}66, 0 0 70px ${ctaGlowColor}44`,
									} as React.CSSProperties
								}
							>
								{ctaLabel}
							</button>
						</div>
					) : null}
				</div>
			</crazygl-content>
		</>
	);
}

export { metadata };
export default function ApiNetworkMap(props: any) {
	return <CrazyGLWrapper hero={ApiNetworkMapHero} metadata={metadata as any} {...props} />;
}
