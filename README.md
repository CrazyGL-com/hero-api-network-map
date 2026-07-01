<sub>*Hero made by [@ybouane](https://x.com/ybouane).*</sub>
<p align="center">
  <img src="https://crazygl.com/heroes/hero-api-network-map/banner-full.png" alt="API Network Map" width="640">
</p>

# @crazygl/hero-api-network-map

A polished, three-dimensional graph of API services connected by glowing lines, with pulses of light traveling along each connection like requests in flight. Built for developer-tools, API-platforms, and infrastructure landing pages.

## Demo
[API Network Map](https://crazygl.com/hero/api-network-map)

## Install

```bash
npm install @crazygl/hero-api-network-map
```

## Usage

```tsx
import HeroApiNetworkMap from '@crazygl/hero-api-network-map';

export default function Hero() {
  return (
    <HeroApiNetworkMap
      nodeLabels={['auth', 'payments', 'db', 'queue', 'edge', 'gateway']}
      connectionDensity={0.45}
      pulseSpeed={0.45}
      onCTAClick="/docs"
    />
  );
}
```

## Customise

- **Content / CTA** — heading, subheading or two-column content, plus a pill CTA (`ctaLabel`, `onCTAClick`, colours).
- **Nodes** — `nodeLabels` (one service per line), `nodeColor` / `accentColor`, `nodeSize`, `nodeMetalness` / `nodeRoughness`, and five label styles (glass / solid / outline / terminal / minimal) with their own colours, scale and offsets.
- **Connections** — `connectionDensity` (fraction of node pairs linked), `lineColor` / `lineOpacity` / `lineWidth`, and pulse controls `pulseColor` / `pulseSpeed` / `pulseIntensity` / `pulsesPerLine`.
- **Camera** — `autoRotate`, `driftSpeed`, `pointerParallax`, `cameraDistance`.
- **Atmosphere** — radial-gradient `bgTop` / `bgBottom`, or `transparentBackground`.

## Best for

- API platforms and developer-tools landing pages.
- Infrastructure, observability and message-bus marketing sites.
- Edge-network and distributed-systems product launches.
- Any hero that needs to read as "live, connected traffic".



This hero is part of [CrazyGL](https://crazygl.com), a collection of production-ready WebGL, canvas, 3D, and typography effects. Every CrazyGL hero ships with an agent-ready `SKILL.md` file that helps developers and coding agents adapt the effect into custom landing pages and interactive experiences.
