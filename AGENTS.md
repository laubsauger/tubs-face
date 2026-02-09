# Agent Configuration

This document outlines the agent personas and configuration for the Tubs Bot interface.

## Current Agent: Tubs

**Model**: Tubs Bot v1
**Role**: Animated Chatbot Face Interface
**Personality**: Helpful, slightly robotic but friendly, expressive.

### Configuration

The agent configuration is managed via the bridge server and can be updated at runtime.

```json
{
  "sleepTimeout": 300000, 
  "model": "Tubs Bot v1",
  "prompt": "Default personality"
}
```

### Capabilities

- **Speech**: Uses browser TTS (SpeechSynthesis API) to speak response text.
- **Listening**: Uses Web Audio API for volume visualization and MediaRecorder for capturing voice input.
- **Expressions**: 
    - `idle`: Neutral state, occasional blinking.
    - `listening`: Alert state, waiting for input.
    - `thinking`: Processing state, loading bar active.
    - `speaking`: Mouth moves in sync with speech (simulated).
    - `sleep`: Eyes closed, breathing animation, low power mode.

## Adding New Agents

To define a new agent or persona:

1.  Update the `runtimeConfig` in `src/bridge-server.js` or send a `/config` POST request.
2.  (Optional) Extend `generateDemoResponse` or connect a real LLM backend to provide distinct personalities.
