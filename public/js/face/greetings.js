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
    // Named only (since we only greet known joins usually)
    "Hey %name%.",
    "%name% joined.",
    "%name% is here too.",
    "Oh hey %name%.",
    "%name%. Good to see you.",
    "%name% is here too. Odds just got better.",
    "Look, it's %name%.",
    "Welcome, %name%.",
    "A wild %name% appeared.",
    "%name% in the frame.",
    "Sup %name%.",
    "Hi %name%. Don't forget the wheel fund.",
    "%name%. We were just talking about you. Kidding.",
    "Hey %name%. Join parameters accepted.",
    "%name%. nice to see you.",
];

export function getRandomWakeGreeting(name) {
    if (!name) {
        const list = WAKE_GREETINGS[0];
        return list[Math.floor(Math.random() * list.length)];
    }
    const list = WAKE_GREETINGS[1];
    const template = list[Math.floor(Math.random() * list.length)];
    return template.replace('%name%', name);
}

export function getRandomJoinGreeting(name) {
    if (!name) return "Someone joined.";
    const template = JOIN_GREETINGS[Math.floor(Math.random() * JOIN_GREETINGS.length)];
    return template.replace('%name%', name);
}
