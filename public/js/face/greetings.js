// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face Greetings Library
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const WAKE_GREETINGS = [
    // Unnamed
    [
        "Hey.",
        "Hi.",
        "Yo.",
        "Hello, stranger.",
        "Ah, there you are.",
        "Hey. Good to see a face.",
        "Hi. Tubs is awake and still underfunded.",
        "Hey. Vibes are free, wheels are not.",
        "You woke me up. Ideally with a donation.",
        "I'm up. Who is this?",
        "Morning. Or afternoon. Whatever time it is.",
        "Scanning... oh, it's a person.",
        "System online. Hello human.",
        "Back online.",
        "Hey there.",
        "Yo. Keep it cool.",
    ],
    // Named (template: replace %name%)
    [
        "Hi %name%.",
        "Hey %name%.",
        "Yo %name%.",
        "%name%, you're back.",
        "Hey there, %name%.",
        "Look who it is: %name%.",
        "%name%. Good timing.",
        "%name%. I woke up broke and dramatic.",
        "Hey %name%. Wheels still not funded.",
        "%name%. Be cool and maybe sponsor me.",
        "Oh, %name%. Hi.",
        "Welcome back, %name%.",
        "%name%. Still looking good.",
        "Yo %name%. What's the move?",
        "Hey %name%. I was dreaming of upgrades.",
        "%name%! I missed you. Briefly.",
        "Greeting recognized user %name%.",
    ]
];

const JOIN_GREETINGS = [
    "Hey %name%.",
    "Yo %name%.",
    "%name% joined.",
    "%name% just rolled in.",
    "%name% is here too.",
    "Oh hey %name%.",
    "%name%. Good to see you.",
    "%name%. Nice entrance.",
    "%name% is here too. Odds just got better.",
    "Look, it's %name%.",
    "There you are, %name%.",
    "Welcome, %name%.",
    "A wild %name% appeared.",
    "%name% in the frame.",
    "Sup %name%.",
    "Hi %name%.",
    "Hi %name%. Wheel fund still open.",
    "%name%. If you brought cash, I respect it.",
    "%name%. We were just talking about you. Kidding.",
    "Hey %name%. Join parameters accepted.",
    "%name%. Nice to see you.",
    "%name% spotted. Chaos level rising.",
    "%name% detected. Vibe check passed.",
    "%name% entered the scene.",
    "%name%. You showed up right on cue.",
    "Tubs approves this arrival: %name%.",
    "%name%. Glad you made it.",
    "%name% is present. Funding still pending.",
    "Well well, %name%.",
    "%name%, you look expensive today.",
    "%name% online.",
    "Okay %name%, now we are cooking.",
    "%name%. Pull up a virtual chair.",
    "Good news, it is %name%.",
    "%name%. Keep that energy.",
    "Hey %name%. Try not to be boring.",
    "%name%. You are right on time for nonsense.",
    "Look who spawned: %name%.",
    "%name%. I accept this development.",
    "%name% pulled up. Respect.",
    "%name%. New round, same wheel fund.",
    "%name% entered. Morale just went up.",
    "Hey %name%. What are we plotting?",
    "%name% joined the party.",
    "%name%. Finally.",
    "Oh look. %name% decided to show up.",
    "%name% has arrived. Proceed accordingly.",
    "Hey %name%. Long time no pixels.",
    "%name%. The algorithm approves.",
    "Yep, that's %name%.",
    "%name% walked in like they own the place.",
    "%name%. I knew I recognized that face.",
    "Attention everyone. %name% is here.",
    "%name%. Welcome to the chaos.",
    "%name% just dropped in.",
    "And there's %name%.",
    "%name%. Right on schedule.",
    "Oh snap, %name%.",
    "%name%. Looking sharp.",
    "%name% in the building.",
    "Hey %name%. Missed you. Kind of.",
    "%name%. My favorite human. Maybe.",
    "Incoming: %name%.",
    "%name% spotted in the wild.",
    "%name%. Hey hey hey.",
    "Is that %name%? It is.",
    "%name% just materialized.",
    "There goes the neighborhood. %name% is here.",
    "%name%. Reporting for duty I see.",
    "Ah yes. %name%. Classic.",
    "%name%. The vibes just shifted.",
    "Camera confirms: %name%.",
    "%name% sighting confirmed.",
    "Well hello %name%.",
    "%name%. Perfect timing as always.",
    "Hey %name%. Don't mind the cameras.",
    "%name%. Acknowledged.",
    "%name% status: present.",
    "%name%. What's good?",
    "Oh it's %name%. Cool cool cool.",
];

const UNKNOWN_JOIN_GREETINGS = [
    "Someone joined.",
    "New face in frame.",
    "Fresh human detected.",
    "Another guest just arrived.",
    "Someone popped in.",
    "Unknown human detected.",
    "Hey, who's that?",
    "New challenger approaching.",
    "Unregistered face detected.",
    "Someone new just showed up.",
    "I see a face I don't know.",
    "Hmm. New person alert.",
    "A mystery guest.",
    "Face detected. Identity unknown.",
    "Who is this? Register yourself.",
    "Stranger danger. Just kidding. Maybe.",
    "New face. Interesting.",
    "Someone's here. Not sure who though.",
    "Unidentified human in range.",
    "I don't recognize this one.",
];

const DEPARTURE_GREETINGS = [
    "%name% left.",
    "%name% walked out.",
    "%name% disappeared.",
    "%name% has left the building.",
    "And %name% is gone.",
    "%name% bounced.",
    "%name% just dipped.",
    "Bye %name%.",
    "%name% exited the frame.",
    "%name% vanished.",
    "There goes %name%.",
    "%name% signed off.",
    "%name% is out.",
    "%name% left the chat. Literally.",
    "%name%. Gone. Just like that.",
    "%name% ghosted us.",
    "Farewell, %name%.",
    "%name% has departed.",
    "Lost visual on %name%.",
    "%name% slipped away.",
    "%name% pulled a disappearing act.",
    "%name% left without saying goodbye.",
    "%name%. Poof.",
    "Camera lost %name%.",
    "%name% is no longer detected.",
    "%name% stepped out.",
    "%name% peaced out.",
    "And just like that, %name% is gone.",
    "%name% left. Mood dropped.",
    "%name% out. Hope they come back.",
];

const UNKNOWN_DEPARTURE_GREETINGS = [
    "Someone left.",
    "A face disappeared.",
    "Unknown person left the frame.",
    "Lost a face.",
    "One less human detected.",
    "Someone just walked away.",
    "Unidentified person departed.",
    "A mystery guest has left.",
    "Face count dropped.",
    "Someone vanished.",
];

const JOIN_GLOBAL_RECENT_LIMIT = 20;
const JOIN_PER_NAME_RECENT_LIMIT = 6;
const UNKNOWN_JOIN_RECENT_LIMIT = 6;
const DEPARTURE_RECENT_LIMIT = 8;
const UNKNOWN_DEPARTURE_RECENT_LIMIT = 3;

const joinGlobalRecent = [];
const joinRecentByName = new Map();
const unknownJoinRecent = [];

function pushRecent(history, value, limit) {
    history.push(value);
    while (history.length > limit) history.shift();
}

function pickJoinTemplate(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return JOIN_GREETINGS[Math.floor(Math.random() * JOIN_GREETINGS.length)];

    let perNameRecent = joinRecentByName.get(key);
    if (!perNameRecent) {
        perNameRecent = [];
        joinRecentByName.set(key, perNameRecent);
    }

    const globalSet = new Set(joinGlobalRecent);
    const perNameSet = new Set(perNameRecent);

    let candidates = JOIN_GREETINGS.filter((line) => !globalSet.has(line) && !perNameSet.has(line));
    if (!candidates.length) {
        candidates = JOIN_GREETINGS.filter((line) => !perNameSet.has(line));
    }
    if (!candidates.length) {
        candidates = JOIN_GREETINGS;
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(joinGlobalRecent, chosen, JOIN_GLOBAL_RECENT_LIMIT);
    pushRecent(perNameRecent, chosen, JOIN_PER_NAME_RECENT_LIMIT);
    return chosen;
}

function pickUnknownJoinTemplate() {
    const recentSet = new Set(unknownJoinRecent);
    let candidates = UNKNOWN_JOIN_GREETINGS.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = UNKNOWN_JOIN_GREETINGS;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(unknownJoinRecent, chosen, UNKNOWN_JOIN_RECENT_LIMIT);
    return chosen;
}

export function getRandomWakeGreeting(name) {
    if (!name) {
        const list = WAKE_GREETINGS[0];
        return list[Math.floor(Math.random() * list.length)];
    }
    const list = WAKE_GREETINGS[1];
    const template = list[Math.floor(Math.random() * list.length)];
    return template.replace('%name%', name);
}

const departureRecent = [];
const unknownDepartureRecent = [];

function pickDepartureTemplate(name) {
    const recentSet = new Set(departureRecent);
    let candidates = DEPARTURE_GREETINGS.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = DEPARTURE_GREETINGS;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(departureRecent, chosen, DEPARTURE_RECENT_LIMIT);
    return chosen;
}

function pickUnknownDepartureTemplate() {
    const recentSet = new Set(unknownDepartureRecent);
    let candidates = UNKNOWN_DEPARTURE_GREETINGS.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = UNKNOWN_DEPARTURE_GREETINGS;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(unknownDepartureRecent, chosen, UNKNOWN_DEPARTURE_RECENT_LIMIT);
    return chosen;
}

export function getRandomJoinGreeting(name) {
    if (!name) {
        return pickUnknownJoinTemplate();
    }
    const template = pickJoinTemplate(name);
    return template.replace('%name%', name);
}

export function getRandomDepartureGreeting(name) {
    if (!name) {
        return pickUnknownDepartureTemplate();
    }
    const template = pickDepartureTemplate(name);
    return template.replace('%name%', name);
}
