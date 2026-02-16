// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face Greetings Library
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let WAKE_GREETINGS = {
    unnamed: ["Hey.", "Hi.", "Yo.", "Hello."],
    named: ["Hi %name%.", "Hey %name%."]
};

let JOIN_GREETINGS = {
    unnamed: ["Someone joined.", "New face in frame."],
    named: ["Hey %name%.", "%name% joined."]
};

let DEPARTURE_GREETINGS = {
    unnamed: ["Someone left.", "A face disappeared."],
    named: ["%name% left.", "%name% walked out."]
};

// Fetch richer greetings from server
fetch('/api/greetings')
    .then(r => r.json())
    .then(data => {
        if (data.wake) WAKE_GREETINGS = data.wake;
        if (data.join) JOIN_GREETINGS = data.join;
        if (data.departure) DEPARTURE_GREETINGS = data.departure;
    })
    .catch(err => console.warn('[Greetings] Failed to load remote greetings:', err));

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
    const list = JOIN_GREETINGS.named;

    if (!key) return list[Math.floor(Math.random() * list.length)];

    let perNameRecent = joinRecentByName.get(key);
    if (!perNameRecent) {
        perNameRecent = [];
        joinRecentByName.set(key, perNameRecent);
    }

    const globalSet = new Set(joinGlobalRecent);
    const perNameSet = new Set(perNameRecent);

    let candidates = list.filter((line) => !globalSet.has(line) && !perNameSet.has(line));
    if (!candidates.length) {
        candidates = list.filter((line) => !perNameSet.has(line));
    }
    if (!candidates.length) {
        candidates = list;
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(joinGlobalRecent, chosen, JOIN_GLOBAL_RECENT_LIMIT);
    pushRecent(perNameRecent, chosen, JOIN_PER_NAME_RECENT_LIMIT);
    return chosen;
}

function pickUnknownJoinTemplate() {
    const list = JOIN_GREETINGS.unnamed;
    const recentSet = new Set(unknownJoinRecent);
    let candidates = list.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = list;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(unknownJoinRecent, chosen, UNKNOWN_JOIN_RECENT_LIMIT);
    return chosen;
}

export function getRandomWakeGreeting(name) {
    if (!name) {
        const list = WAKE_GREETINGS.unnamed;
        return list[Math.floor(Math.random() * list.length)];
    }
    const list = WAKE_GREETINGS.named;
    const template = list[Math.floor(Math.random() * list.length)];
    return template.replace('%name%', name);
}

const departureRecent = [];
const unknownDepartureRecent = [];

function pickDepartureTemplate(name) {
    const list = DEPARTURE_GREETINGS.named;
    const recentSet = new Set(departureRecent);
    let candidates = list.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = list;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    pushRecent(departureRecent, chosen, DEPARTURE_RECENT_LIMIT);
    return chosen;
}

function pickUnknownDepartureTemplate() {
    const list = DEPARTURE_GREETINGS.unnamed;
    const recentSet = new Set(unknownDepartureRecent);
    let candidates = list.filter((line) => !recentSet.has(line));
    if (!candidates.length) candidates = list;
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
