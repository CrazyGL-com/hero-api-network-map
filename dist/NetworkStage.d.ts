import * as React from 'react';
interface StageProps {
    rootRef: React.RefObject<HTMLElement | null>;
    size: {
        width: number;
        height: number;
        dpr: number;
    };
    input: {
        x: number;
        y: number;
        active: boolean;
    };
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
export default function NetworkStage(props: StageProps): import("react/jsx-runtime").JSX.Element;
export {};
