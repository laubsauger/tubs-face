const ROBOT_FX = {
    svg: {
        viewBox: { w: 52.82, h: 27.45 },
        shapes: [{ "x": 0, "y": 0, "w": 14.59, "h": 22.47, "rx": 5.94, "ry": 5.94 }, { "x": 40.85, "y": 0, "w": 14.59, "h": 22.47, "rx": 5.94, "ry": 5.94 }, { "x": 20.53, "y": 23.86, "w": 14.38, "h": 6.44, "rx": 1.95, "ry": 1.95 }]
    },
    pixel: {
        size: 21, gap: 7,
        edgeSoftness: 0, borderRadius: 0,
    },
    color: {
        base: '#a855f7', hueVariation: 8,
        brightnessVariation: 8, opacityMin: 0.5,
    },
    glow: {
        pixelGlow: 14, outerBloom: 0,
        bloomIntensity: 1, color: '#5900ff',
        falloffCurve: 2.8,
    },
    brightnessPulse: {
        enabled: true, dim: 0.62,
        bright: 1, speed: 17,
    },
    scanBeam: {
        enabled: true, speed: 10,
        lineWidth: 7, brightness: 0.65,
        glowStrength: 26, jitter: 1,
        color: '#a600ff',
    },
    chromatic: {
        enabled: true, offsetX: 0,
        offsetY: 4.5, intensity: 0.65,
        animate: true, animateSpeed: 7,
    },
    glitchSlice: {
        enabled: true, sliceCount: 24,
        maxOffset: 5, speed: 28,
        intensity: 0.53, colorShift: 0.03,
        gapChance: 0.07,
        interval: 6200, burstDuration: 3000,
    },
    glitch: {
        scanlines: true, scanlineIntensity: 0.41,
        scanlineSpacing: 5, scanlineThickness: 3,
        scanlineMove: true, scanlineSpeed: 26,
        pixelJitter: 0, flicker: true,
        flickerSpeed: 11, flickerDepth: 0.02,
    }
};