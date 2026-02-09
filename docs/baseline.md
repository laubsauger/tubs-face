TUBS BOT
Animated Chatbot Face Interface
Product Specification & Planning Document  //  February 2026

1. Overview
Tubs Bot is an animated chatbot face interface designed to serve as the visual front-end for a conversational AI. The face displays expressive eyes and mouth animations in the center of the screen, surrounded by real-time stats, tools, and status indicators in each corner. The interface communicates with a backend chatbot via a WebSocket bridge server.

Platform: Single-file HTML + Node.js bridge server
Target: Dedicated screen (tablet, monitor, or kiosk display)
Input: Voice (spacebar push-to-talk), WebSocket API, keyboard
Output: Browser TTS, animated face expressions

2. Architecture
The system uses a three-layer architecture connecting the face UI to any chatbot backend.

Layer
Component
Description
Frontend
public/{index.html, css/, js/}
Animated face, stats panels, voice input, TTS output (HTML/CSS/JS split)
Bridge
src/bridge-server.js
Node.js WebSocket server relaying messages and serving static files from public/
Backend
Any LLM / chatbot
Connected via HTTP POST to /speak endpoint or WebSocket

3. Screen Layout
The interface is divided into five zones: a center stage for the face, and four corner panels for stats and tools.

TOP-LEFT: System Vitals

TOP-RIGHT: Input Status

CENTER
Face / Eyes / Mouth

BOTTOM-LEFT: Chat Log

BOTTOM-RIGHT: Bot Stats

4. Corner Panels — Stats & Tools
4.1 Top-Left: System Vitals
Real-time system health and connection info.

Stat
Display
Source
Connection Status
Colored dot + Online/Offline
WebSocket state
Uptime
HH:MM:SS since wake
JS timer, resets on sleep/wake
Awake Since
Timestamp of last wake
Set on wake from sleep mode
WebSocket Latency
Ping in ms
Periodic ping/pong measurement
Model Info
Name + version label
Sent from bridge server on connect
Clock
Current time (subtle)
JS Date, updates every minute

4.2 Top-Right: Input / Listening Status
Shows what Tubs is currently hearing and the state of voice input.

Stat
Display
Source
Mic Active
Animated icon when recording
MediaRecorder state
Volume Meter
Small bar showing live input level
AnalyserNode frequency data
Input Source
Label: Voice / Keyboard / API
Set per input event
Last Heard
Timestamp of last input
Updated on each message received
STT Confidence
Percentage or bar
Whisper or STT engine confidence score
Waveform
Mini waveform during recording
Already exists, relocate to corner

4.3 Bottom-Left: Chat Log
Scrolling log of conversation activity, color-coded by type. This panel already exists in the current build and will be repositioned.

Feature
Display
Notes
Message Feed
Timestamped, color-coded lines
Green = incoming, Blue = outgoing, Yellow = system
Turn Counter
Small count of conversation turns
Increments per user/bot exchange
Expand/Collapse
Click or key to toggle full log
Collapsed = last 6-8 lines, expanded = scrollable
Message Count
Total messages this session
Reset on sleep/wake or page reload

4.4 Bottom-Right: Bot Stats
Performance and usage stats from the chatbot backend.

Stat
Display
Source
Response Time
Last LLM response latency in ms
Measured from send to first token
Tokens In/Out
Per-message and session totals
Returned from LLM API or bridge
Queue Depth
Messages waiting to be spoken
TTS queue length
Current Expression
Label: IDLE / SPEAKING / etc.
Already exists, relocate to corner
Session Cost
Estimated $ if using paid API
Calculated from token counts + rate
Context/Prompt
Active personality or system prompt
Sent from bridge on connect or change


5. Sleep Mode
Sleep mode is a low-power idle state that Tubs enters after inactivity or on command. It provides a clear visual distinction between active and dormant states.

5.1 Entering Sleep
	•	Auto-sleep after configurable inactivity timeout (default: 5 minutes)
	•	Manual sleep via voice command ("Go to sleep, Tubs") or keyboard shortcut
	•	API trigger via WebSocket message: { type: "sleep" }

5.2 Sleep Visuals
	•	Eyes close (eyelids slide down fully)
	•	Screen dims to ~10% brightness via CSS filter
	•	All corner stats fade out except a subtle clock
	•	Slow breathing animation: gentle scale pulse on the face (2-3 second cycle)
	•	Optional: small "zzz" animation or subtle particle drift
	•	Loading bar hidden, waveform hidden

5.3 Waking Up
	•	Spacebar press
	•	Any incoming WebSocket message of type "wake" or "speak"
	•	Voice detection (if ambient listening is enabled)
	•	Screen tap / click

5.4 Wake Sequence
	•	Screen brightens over 0.5s
	•	Eyes open with a slow blink
	•	Corner stats fade in (staggered, 0.2s apart)
	•	Uptime timer resets
	•	Optional greeting: "I'm back! What's up?"


6. WebSocket Message Protocol
All messages between the bridge server and face UI are JSON objects with a "type" field. Below are the current and proposed message types.

Type
Direction
Payload
Action
speak
Server → Face
{ text }
Queue TTS, show speech text, animate mouth
incoming
Server → Face
{ text, from }
Log message, set listening expression
thinking
Server → Face
{}
Show loading bar, thinking expression
expression
Server → Face
{ expression }
Set face expression manually
system
Server → Face
{ text }
Log system message
error
Server → Face
{ text }
Log error, clear loading
sleep
Server → Face
{}
Enter sleep mode
wake
Server → Face
{}
Exit sleep mode
stats
Server → Face
{ tokens, latency, model, cost }
Update bot stats panel
config
Server → Face
{ sleepTimeout, model, prompt }
Update runtime configuration
ping
Both
{ ts }
Latency measurement

Purple = new, Green = new, Blue = new, Yellow = new. White = existing.


7. Bridge Server API Endpoints
HTTP endpoints on the bridge server for external integrations.

Endpoint
Method
Body
Purpose
/
GET
--
Serve face UI
/health
GET
--
Health check + client count
/speak
POST
{ text }
Send speech to face
/voice
POST
FormData (audio)
Voice input → transcription → LLM → speak
/sleep
POST
--
Trigger sleep mode
/wake
POST
--
Trigger wake from sleep
/stats
GET
--
Return current session stats JSON
/config
POST
{ sleepTimeout, ... }
Update runtime config


8. Implementation Phases
Suggested build order, from foundational to nice-to-have.

Phase 1: Layout & Corner Panels
	•	Restructure HTML into a CSS Grid with 5 zones (4 corners + center)
	•	Move existing chat log to bottom-left panel
	•	Move existing status indicators to top-left panel
	•	Add placeholder panels for top-right and bottom-right
	•	Ensure responsive scaling (works on tablet and desktop)

Phase 2: Stats Population
	•	Add uptime timer and clock to top-left
	•	Build live volume meter and mic indicator for top-right
	•	Add response time tracking and token counter to bottom-right
	•	Extend bridge server to send stats messages after each LLM call
	•	Add turn counter and message count to chat log panel

Phase 3: Sleep Mode
	•	Implement sleep state with dim screen, closed eyes, breathing animation
	•	Add auto-sleep timer with configurable timeout
	•	Build wake triggers (spacebar, click, WebSocket, voice)
	•	Add wake-up animation sequence
	•	Add /sleep and /wake endpoints to bridge server

Phase 4: Protocol & Config
	•	Add new WebSocket message types (sleep, wake, stats, config, ping)
	•	Build ping/pong latency measurement
	•	Add /config endpoint for runtime settings
	•	Add /stats endpoint for external monitoring

Phase 5: Polish & Extras
	•	Staggered fade-in animations on wake
	•	Expand/collapse toggle on chat log
	•	Session cost tracker (if using paid API)
	•	Context/personality indicator in bot stats
	•	Ambient listening mode for hands-free wake


9. Future Ideas (Parking Lot)
Not in scope for v1, but worth tracking for later.

	•	Emotion engine: sentiment analysis on LLM responses to auto-set expressions
	•	Pupil tracking: eyes follow cursor or move randomly during idle
	•	More expression states: confused, annoyed, surprised, sleepy, skeptical
	•	Mouth shape variety: smirk, frown, O-shape for surprise
	•	Multi-screen: separate face display and control dashboard
	•	Notification system: Tubs alerts you to events (timer, reminder, news)
	•	Theme support: color schemes, dark/light, seasonal skins
	•	Avatar customization: swap face parts (hat, glasses, colors)
	•	Audio output: switch from browser TTS to ElevenLabs or similar
	•	Persistent memory: Tubs remembers past conversations across sessions
